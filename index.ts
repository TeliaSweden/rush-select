#!/usr/bin/env node
import path from 'path'

import { spawnStreaming } from '@lerna/child-process'
import colors from 'ansi-colors'
import RushSelect from './prompt'
import { createChoices, setInitialValuesOnChoices } from './choice-generation'
import { save, load } from './save-load'
import { getProjectsAndRespectivePackageJson, getRushRootDir } from './rush-utils'

import { getArgs } from './yargs'
const { argv } = getArgs()

// scripts that should be executed with this prompt. Can be edited, shouldn't break anything
// the order of the strings will be preserved in the prompt
if (argv.include === undefined) {
  argv.include = null
} else if (!Array.isArray(argv.include)) {
  argv.include = [argv.include]
}

if (argv.exclude === undefined) {
  argv.exclude = null
} else if (!Array.isArray(argv.exclude)) {
  argv.exclude = [argv.exclude]
}

const isScriptNameAllowed = (scriptName: any) =>
  (argv.include === null || argv.include.includes(scriptName)) &&
  (argv.exclude === null || !argv.exclude.includes(scriptName))

const createRushPrompt = async (choices: any, allScriptNames: any, projects: any) => {
  const rushSelect = new RushSelect({
    name: 'rush-select',
    message:
      'Select what to run. Use left/right arrows to change options, Enter key starts execution.',
    messageWidth: 150,
    margin: [0, 1, 0, 0],
    styles: { primary: colors.grey },
    choices,
    executionGroups: [
      {
        category: 'pre-scripts (executes from top to bottom)',
        name: 'rush',
        initial: 0,
        scriptNames: ['ignore', 'install', 'update'],
        scriptExecutable: 'rush',
        customSortText: '_',
        scriptCommand: []
      },
      {
        category: 'rush build (recommended: smart)',
        name: 'rush build',
        initial: 1,
        allowMultipleScripts: false,
        scriptNames: ['ignore', 'smart', 'regular', 'rebuild'],
        scriptExecutable: 'rush',
        customSortText: '__',
        scriptCommand: []
      }
    ],
    edgeLength: 2,
    // the description above the items
    scale: allScriptNames.sort().map((name: any) => ({
      name
    }))
  })

  const scriptsToRun = await rushSelect.run()

  if (scriptsToRun.length === 0) {
    return null
  }

  const scripts = {
    pre: [],
    rushBuild: undefined,
    main: []
  }

  scriptsToRun
    .filter(({ script }: any) => script !== undefined)
    .forEach((item: any) => {
      if (item === null) {
        return
      }

      if (item.packageName === 'rush') {
        // @ts-expect-error ts-migrate(2345) FIXME: Argument of type 'any' is not assignable to parame... Remove this comment to see the full error message
        scripts.pre.push(item)
        return
      }

      if (item.packageName === 'rush build') {
        scripts.rushBuild = item
        return
      }

      // add project reference
      const project = projects.find((p: any) => p.packageName === item.packageName)
      if (project) {
        scripts.main.push({
          ...item,
          // @ts-expect-error ts-migrate(2322) FIXME: Type 'any' is not assignable to type 'never'.
          project
        })
      }
    })

  save(getRushRootDir(), scripts.main)

  return scripts
}

const runScripts = (scriptsToRun: any) => {
  const getPrefix = (packageName: any, script: any) => packageName + ' > ' + script + ' '
  const longestSequence = scriptsToRun.reduce((val: any, curr: any) => {
    const result = getPrefix(curr.packageName, curr.script).length

    return result > val ? result : val
  }, 0)

  return scriptsToRun.map(
    ({ packageName, script, project, scriptExecutable = 'npm', scriptCommand = ['run'] }: any) =>
      spawnStreaming(
        scriptExecutable,
        scriptCommand.concat(script),
        { cwd: project ? path.resolve(getRushRootDir(), project.projectFolder) : getRushRootDir() },
        getPrefix(packageName, script).padEnd(longestSequence, ' ')
      )
  )
}

// makes user able to CTRL + C during execution
const awaitProcesses = async (processes: any) => {
  let error = false

  for (const process of processes) {
    await new Promise((resolve) => {
      let resolved = false
      process.once('exit', (exitCode: number) => {
        if (exitCode !== 0) {
          error = true
        }
        if (!resolved) {
          resolved = true
          resolve(exitCode)
        }
      })

      process.once('close', (exitCode: number) => {
        if (exitCode !== 0) {
          error = true

          if (exitCode === -2) {
            console.warn(
              'There was an error. Double-check that you have installed rush via "npm install -g @microsoft/rush'
            )
          }
        }
        if (!resolved) {
          resolved = true
          resolve(exitCode)
        }
      })
    })
  }

  return { error }
}

async function main() {
  const projects = getProjectsAndRespectivePackageJson()

  do {
    const { choices, allScriptNames } = createChoices(projects, isScriptNameAllowed)
    const savedProjectScripts = load(getRushRootDir())
    setInitialValuesOnChoices(choices, savedProjectScripts, isScriptNameAllowed)

    let scripts = null

    try {
      scripts = await createRushPrompt(choices, allScriptNames, projects)
    } catch (e) {
      if (e === '') {
        // user aborted prompt
        return
      }
      throw e
    }

    if (scripts === null) {
      return
    }

    console.log('Starting pre-scripts')

    let anyError

    // run through the prescripts sequentially
    for (const preScript of scripts.pre) {
      const { error } = await awaitProcesses(runScripts([preScript]))

      anyError = anyError || error
    }

    if (!anyError) {
      let rushBuildProcess

      // get unique package names that are set to run scripts
      const packagesThatWillRunScripts = Array.from(
        scripts.main.reduce((set, item) => {
          // @ts-expect-error ts-migrate(2339) FIXME: Property 'packageName' does not exist on type 'nev... Remove this comment to see the full error message
          set.add(item.packageName)
          return set
        }, new Set())
      )

      if (scripts.rushBuild) {
        // @ts-expect-error ts-migrate(2532) FIXME: Object is possibly 'undefined'.
        if (scripts.rushBuild.script === 'smart' && packagesThatWillRunScripts.length > 0) {
          const executable = 'rush'
          // @ts-expect-error ts-migrate(2339) FIXME: Property 'flat' does not exist on type 'unknown[][... Remove this comment to see the full error message
          const args = ['build'].concat(packagesThatWillRunScripts.map((p) => ['--to', p]).flat())

          console.log('Starting smart rush build step: ' + executable + ' ' + args.join(' '))

          rushBuildProcess = spawnStreaming(
            executable,
            args,
            { cwd: getRushRootDir(), stdio: 'inherit' },
            'smart rush build'
          )
          // @ts-expect-error ts-migrate(2532) FIXME: Object is possibly 'undefined'.
        } else if (scripts.rushBuild.script === 'regular') {
          const executable = 'rush'
          const args = ['build']

          console.log('Starting regular rush build step: ' + executable + ' ' + args.join(' '))

          rushBuildProcess = spawnStreaming(
            executable,
            args,
            { cwd: getRushRootDir() },
            'incremental rush build'
          )
          // @ts-expect-error ts-migrate(2532) FIXME: Object is possibly 'undefined'.
        } else if (scripts.rushBuild.script === 'rebuild') {
          const executable = 'rush'
          const args = ['rebuild']

          console.log(
            'Starting rush rebuild step, building everything. Grab coffee.. ' +
              executable +
              ' ' +
              args.join(' ')
          )

          rushBuildProcess = spawnStreaming(
            executable,
            args,
            { cwd: getRushRootDir() },
            'rush rebuild'
          )
        }

        if (rushBuildProcess) {
          const { error } = await awaitProcesses([rushBuildProcess])

          // weirdly, rush doesn't seem to exit with non-zero when builds fail..
          anyError = anyError || error
        }
      }
    }

    if (!anyError) {
      console.log('Starting main scripts')

      await awaitProcesses(runScripts(scripts.main))
    } else {
      throw new Error('there was an error')
    }

    // eslint-disable-next-line
  } while (true)
}

module.exports = main()
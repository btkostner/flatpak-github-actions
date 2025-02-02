const core = require('@actions/core')
const exec = require('@actions/exec')
const artifact = require('@actions/artifact')
const cache = require('@actions/cache')
const path = require('path')
const fs = require('fs').promises
const yaml = require('js-yaml')
const crypto = require('crypto')

// The various paths to cache
const CACHE_PATH = [
  '.flatpak-builder'
]

/**
 * Compute a SHA-256 hash of the manifest file.
 * @param {PathLike} manifestPath
 */
const computeHash = async (manifestPath) => {
  const hash = crypto.createHash('sha256')
  const stream = await fs.readFile(manifestPath)

  const buffer = Buffer.alloc(stream.byteLength)
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = stream[i]
  }
  hash.update(buffer)

  return hash.digest('hex')
}

/**
 * Parses a flatpak manifest and returns it as a JS object
 * It supports both supported file formats by flatpak-builder: JSON & YAML.
 *
 * @param {PathLike} manifestPath the relative/absolute path to the manifest
 */
const parseManifest = async (manifestPath) => {
  const data = await fs.readFile(manifestPath)
  let manifest = null
  switch (path.extname(manifestPath)) {
    case '.json':
      manifest = JSON.parse(data)
      break
    case '.yaml':
    case '.yml':
      manifest = yaml.safeLoad(data)
      break
    default:
      core.setFailed(
        'Unsupported manifest format, please use a YAML or a JSON file'
      )
  }
  return manifest
}

/**
 * Saves a manifest as a YAML or JSON file
 *
 * @param {object} manifest A flatpak manifest
 * @param {PathLike} dest Where to save the flatpak manifest
 * @returns {object} manifest
 */
const saveManifest = async (manifest, dest) => {
  let data = null
  switch (path.extname(dest)) {
    case '.json':
      data = JSON.stringify(manifest)
      break
    case '.yaml':
    case '.yml':
      data = yaml.safeDump(manifest)
      break
    default:
      core.setFailed(
        'Unsupported manifest format, please use a YAML or a JSON file'
      )
  }
  await fs.writeFile(dest, data)
  return manifest
}

/**
 * Applies the following changes to the original manifest:
 * 1 - If tests are enabled, proper test-args are added
 *      to enable network & x11 access.
 *
 * @param {Object} manifest the parsed manifest
 * @param {boolean} runTests whether to run tests or not
 * @returns {object} manifest the modified manifest
 */
const modifyManifest = (manifest, runTests = false) => {
  if (runTests) {
    const buildOptions = manifest['build-options'] || {}
    const env = {
      ...(buildOptions.env || {}),
      DISPLAY: '0:0'
    }
    const testArgs = [
      '--socket=x11',
      '--share=network',
      ...(buildOptions['test-args'] || [])
    ]

    manifest['build-options'] = {
      ...buildOptions,
      'test-args': testArgs,
      env: env
    }
    const module = manifest.modules.slice(-1)[0]
    module['run-tests'] = runTests
  }
  return manifest
}

/**
 * Build the flatpak & create a bundle from the build
 *
 * @param {object} manifest A flatpak manifest
 * @param {object} manifestPath The flatpak manifest path
 * @param {string} bundle The bundle's name
 * @param {string} repositoryUrl The repository used to install the runtime from
 * @param {string} repositoryName The repository name used to install the runtime from
 * @param {string} buildDir Where to build the application
 * @param {string} localRepoName The flatpak repository name
 * @param {boolean} cacheBuildDir Whether to enable caching the build directory
 * @param {string} cacheKey The key used to cache the build directory
 */
const build = async (manifest, manifestPath, bundle, repositoryUrl, repositoryName, buildDir, localRepoName, cacheBuildDir, cacheKey) => {
  const appId = manifest['app-id'] || manifest.id
  const branch = manifest.branch || core.getInput('branch') || 'master'

  core.info('Building the flatpak...')

  const args = [
        `--repo=${localRepoName}`,
        '--disable-rofiles-fuse',
        `--install-deps-from=${repositoryName}`,
        '--force-clean'
  ]
  if (cacheBuildDir) {
    args.push('--ccache')
  }
  args.push(buildDir, manifestPath)

  await exec.exec('xvfb-run --auto-servernum flatpak-builder', args)
  if (cacheBuildDir) {
    await cache.saveCache(
      CACHE_PATH,
      cacheKey
    ).catch((reason) => {
      core.error(`Failed to save cache: ${reason}`)
    })
  }

  core.info('Creating a bundle...')
  await exec.exec('flatpak', [
    'build-bundle',
    localRepoName,
    bundle,
        `--runtime-repo=${repositoryUrl}`,
        appId,
        branch
  ])
}

/**
 * Initialize the build
 * It consists mostly of setting up the flatpak remote if one other than the default is set
 * along with restoring the cache from the latest build
 *
 * @param {string} repositoryName the repository name to install the runtime from
 * @param {string} repositoryUrl the repository url
 * @param {PathLike} manifestPath the manifest path
 * @param {Boolean} cacheBuildDir whether to cache the build dir or not
 * @param {string | undefined} cacheKey the default cache key if there are any
 * @returns {Promise<String>} the new cacheKey if none was set before
 */
const prepareBuild = async (repositoryName, repositoryUrl, manifestPath, cacheBuildDir, cacheKey = undefined) => {
  /// If the user has set a different runtime source
  if (repositoryUrl !== 'https://flathub.org/repo/flathub.flatpakrepo') {
    await exec.exec('flatpak', ['remote-add', '--if-not-exists', repositoryName, repositoryUrl])
  }

  // Restore the cache in case caching is enabled
  if (cacheBuildDir) {
    if (cacheKey === undefined) {
      const manifestHash = (await computeHash(manifestPath)).substring(0, 20)
      cacheKey = `flatpak-builder-${manifestHash}`
    }

    const cacheHitKey = await cache.restoreCache(
      CACHE_PATH,
      cacheKey,
      [
        'flatpak-builder-',
        'flatpak-'
      ]
    )
    if (cacheHitKey !== undefined) {
      core.info(`Restored cache with key: ${cacheHitKey}`)
    } else {
      core.info('No cache was found')
    }
  }
  return cacheKey
}

/**
 * Run a complete build
 *
 * @param {object} manifestPath The flatpak manifest path
 * @param {boolean} runTests Whether to run tests or not
 * @param {string} bundle The bundle's name
 * @param {string} repositoryUrl The repository used to install the runtime from
 * @param {string} repositoryName the repository name to install the runtime from
 * @param {string} buildDir Where to build the application
 * @param {string} localRepoName The flatpak repository name
 * @param {boolean} cacheBuildDir Whether to enable caching the build directory
 * @param {string | undefined} cacheKey the default cache key if there are any
 */
const run = async (
  manifestPath,
  runTests,
  bundle,
  repositoryUrl,
  repositoryName,
  buildDir,
  localRepoName,
  cacheBuildDir,
  cacheKey = undefined
) => {
  try {
    cacheKey = await prepareBuild(repositoryName, repositoryUrl, manifestPath, cacheBuildDir, cacheKey)
  } catch (err) {
    core.setFailed(`Failed to prepare the build ${err}`)
  }

  parseManifest(manifestPath)
    .then((manifest) => {
      const modifiedManifest = modifyManifest(manifest, runTests)
      return saveManifest(modifiedManifest, manifestPath)
    })
    .then((manifest) => {
      return build(manifest, manifestPath, bundle, repositoryUrl, repositoryName, buildDir, localRepoName, cacheBuildDir, cacheKey)
    })
    .then(() => {
      core.info('Uploading artifact...')
      const artifactClient = artifact.create()

      return artifactClient.uploadArtifact(bundle.replace('.flatpak', ''), [bundle], '.', {
        continueOnError: false
      })
    })
    .catch((error) => {
      core.setFailed(`Build failed: ${error}`)
    })
}

module.exports = {
  computeHash,
  parseManifest,
  modifyManifest,
  saveManifest,
  build,
  run
}

if (require.main === module) {
  run(
    core.getInput('manifest-path'),
    ['y', 'yes', 'true', 'enabled', true].includes(core.getInput('run-tests')),
    core.getInput('bundle') || 'app.flatpak',
    core.getInput('repository-url'),
    core.getInput('repository-name'),
    'flatpak_app',
    'repo',
    ['y', 'yes', 'true', 'enabled', true].includes(core.getInput('cache')),
    core.getInput('cache-key')
  )
}

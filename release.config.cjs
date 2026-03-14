const fs = require('node:fs')
const path = require('node:path')

function readPackageJson() {
  const packagePath = path.join(__dirname, 'package.json')
  if (!fs.existsSync(packagePath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(packagePath, 'utf8'))
}

const pkg = readPackageJson()
const hasPackageJson = pkg !== null
const buildsReleaseArtifacts = Boolean(pkg?.scripts?.['build:release'])

/** @type {import('semantic-release').GlobalConfig} */
module.exports = {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    ...(buildsReleaseArtifacts
      ? [
          [
            '@semantic-release/exec',
            {
              prepareCmd: 'bun run build:release',
            },
          ],
        ]
      : []),
    [
      '@semantic-release/github',
      {
        assets: buildsReleaseArtifacts ? ['dist/**'] : [],
        addReleases: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        successComment: false,
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', ...(hasPackageJson ? ['package.json'] : [])],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
}

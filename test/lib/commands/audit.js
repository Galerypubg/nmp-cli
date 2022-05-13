const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const t = require('tap')

const { load: loadMockNpm, fake: mockNpm } = require('../../fixtures/mock-npm')
const MockRegistry = require('../../fixtures/mock-registry.js')

const gunzip = zlib.gunzipSync
const gzip = zlib.gzipSync

t.cleanSnapshot = str => str.replace(/packages in [0-9]+[a-z]+/g, 'packages in xxx')

const tree = {
  'package.json': JSON.stringify({
    name: 'test-dep',
    version: '1.0.0',
    dependencies: {
      'test-dep-a': '*',
    },
  }),
  'package-lock.json': JSON.stringify({
    name: 'test-dep',
    version: '1.0.0',
    lockfileVersion: 2,
    requires: true,
    packages: {
      '': {
        xname: 'scratch',
        version: '1.0.0',
        dependencies: {
          'test-dep-a': '*',
        },
        devDependencies: {},
      },
      'node_modules/test-dep-a': {
        name: 'test-dep-a',
        version: '1.0.0',
      },
    },
    dependencies: {
      'test-dep-a': {
        version: '1.0.0',
      },
    },
  }),
  'test-dep-a-vuln': {
    'package.json': JSON.stringify({
      name: 'test-dep-a',
      version: '1.0.0',
    }),
    'vulnerable.txt': 'vulnerable test-dep-a',
  },
  'test-dep-a-fixed': {
    'package.json': JSON.stringify({
      name: 'test-dep-a',
      version: '1.0.1',
    }),
    'fixed.txt': 'fixed test-dep-a',
  },
}

t.test('normal audit', async t => {
  const { npm, joinedOutput } = await loadMockNpm(t, {
    prefixDir: tree,
  })
  const registry = new MockRegistry({
    tap: t,
    registry: npm.config.get('registry'),
  })

  const manifest = registry.manifest({
    name: 'test-dep-a',
    packuments: [{ version: '1.0.0' }, { version: '1.0.1' }],
  })
  await registry.package({ manifest })
  const advisory = registry.advisory({
    id: 100,
    vulnerable_versions: '<1.0.1',
  })
  const bulkBody = gzip(JSON.stringify({ 'test-dep-a': ['1.0.0'] }))
  registry.nock.post('/-/npm/v1/security/advisories/bulk', bulkBody)
    .reply(200, {
      'test-dep-a': [advisory],
    })

  await npm.exec('audit', [])
  t.ok(process.exitCode, 'would have exited uncleanly')
  process.exitCode = 0
  t.matchSnapshot(joinedOutput())
})

t.test('fallback audit ', async t => {
  const { npm, joinedOutput } = await loadMockNpm(t, {
    prefixDir: tree,
  })
  const registry = new MockRegistry({
    tap: t,
    registry: npm.config.get('registry'),
  })
  const manifest = registry.manifest({
    name: 'test-dep-a',
    packuments: [{ version: '1.0.0' }, { version: '1.0.1' }],
  })
  await registry.package({ manifest })
  const advisory = registry.advisory({
    id: 100,
    module_name: 'test-dep-a',
    vulnerable_versions: '<1.0.1',
    findings: [{ version: '1.0.0', paths: ['test-dep-a'] }],
  })
  registry.nock
    .post('/-/npm/v1/security/advisories/bulk').reply(404)
    .post('/-/npm/v1/security/audits/quick', body => {
      const unzipped = JSON.parse(gunzip(Buffer.from(body, 'hex')))
      return t.match(unzipped, {
        name: 'test-dep',
        version: '1.0.0',
        requires: { 'test-dep-a': '*' },
        dependencies: { 'test-dep-a': { version: '1.0.0' } },
      })
    }).reply(200, {
      actions: [],
      muted: [],
      advisories: {
        100: advisory,
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
        dependencies: 1,
        devDependencies: 0,
        optionalDependencies: 0,
        totalDependencies: 1,
      },
    })
  await npm.exec('audit', [])
  t.ok(process.exitCode, 'would have exited uncleanly')
  process.exitCode = 0
  t.matchSnapshot(joinedOutput())
})

t.test('json audit', async t => {
  const { npm, joinedOutput } = await loadMockNpm(t, {
    prefixDir: tree,
    config: {
      json: true,
    },
  })
  const registry = new MockRegistry({
    tap: t,
    registry: npm.config.get('registry'),
  })

  const manifest = registry.manifest({
    name: 'test-dep-a',
    packuments: [{ version: '1.0.0' }, { version: '1.0.1' }],
  })
  await registry.package({ manifest })
  const advisory = registry.advisory({ id: 100 })
  const bulkBody = gzip(JSON.stringify({ 'test-dep-a': ['1.0.0'] }))
  registry.nock.post('/-/npm/v1/security/advisories/bulk', bulkBody)
    .reply(200, {
      'test-dep-a': [advisory],
    })

  await npm.exec('audit', [])
  t.ok(process.exitCode, 'would have exited uncleanly')
  process.exitCode = 0
  t.matchSnapshot(joinedOutput())
})

t.test('audit fix - bulk endpoint', async t => {
  const { npm, joinedOutput } = await loadMockNpm(t, {
    prefixDir: tree,
  })
  const registry = new MockRegistry({
    tap: t,
    registry: npm.config.get('registry'),
  })
  const manifest = registry.manifest({
    name: 'test-dep-a',
    packuments: [{ version: '1.0.0' }, { version: '1.0.1' }],
  })
  await registry.package({
    manifest,
    tarballs: {
      '1.0.1': path.join(npm.prefix, 'test-dep-a-fixed'),
    },
  })
  const advisory = registry.advisory({ id: 100, vulnerable_versions: '1.0.0' })
  registry.nock.post('/-/npm/v1/security/advisories/bulk', body => {
    const unzipped = JSON.parse(gunzip(Buffer.from(body, 'hex')))
    return t.same(unzipped, { 'test-dep-a': ['1.0.0'] })
  })
    .reply(200, { // first audit
      'test-dep-a': [advisory],
    })
    .post('/-/npm/v1/security/advisories/bulk', body => {
      const unzipped = JSON.parse(gunzip(Buffer.from(body, 'hex')))
      return t.same(unzipped, { 'test-dep-a': ['1.0.1'] })
    })
    .reply(200, { // after fix
      'test-dep-a': [],
    })
  await npm.exec('audit', ['fix'])
  t.matchSnapshot(joinedOutput())
  const pkg = fs.readFileSync(path.join(npm.prefix, 'package-lock.json'), 'utf8')
  t.matchSnapshot(pkg, 'lockfile has test-dep-a@1.0.1')
  t.ok(
    fs.existsSync(path.join(npm.prefix, 'node_modules', 'test-dep-a', 'fixed.txt')),
    'has test-dep-a@1.0.1 on disk'
  )
})

t.test('completion', async t => {
  const { npm } = await loadMockNpm(t)
  const audit = await npm.cmd('audit')
  t.test('fix', async t => {
    await t.resolveMatch(
      audit.completion({ conf: { argv: { remain: ['npm', 'audit'] } } }),
      ['fix'],
      'completes to fix'
    )
  })

  t.test('subcommand fix', async t => {
    await t.resolveMatch(
      audit.completion({ conf: { argv: { remain: ['npm', 'audit', 'fix'] } } }),
      [],
      'resolves to ?'
    )
  })

  t.test('subcommand not recognized', async t => {
    await t.rejects(audit.completion({ conf: { argv: { remain: ['npm', 'audit', 'repare'] } } }), {
      message: 'repare not recognized',
    })
  })
})

t.test('audit signatures', async t => {
  const mocks = {
    '../../../lib/utils/reify-finish.js': () => Promise.resolve(),
  }
  const Audit = t.mock('../../../lib/commands/audit.js', mocks)

  let npmOutput = []
  const joinedOutput = () => npmOutput.join('\n')

  let npm
  let audit
  let registry

  t.beforeEach(() => {
    npm = mockNpm({
      prefix: t.testdirName,
      config: {
        global: false,
        missing: false,
        json: false,
        omit: [],
      },
      flatOptions: {
        workspacesEnabled: true,
      },
      output: (str) => {
        npmOutput.push(str)
      },
    })

    audit = new Audit(npm)

    registry = new MockRegistry({
      tap: t,
      registry: npm.config.get('registry'),
    })
  })

  t.afterEach(() => {
    npmOutput = []
  })

  function validInstall () {
    return t.testdir({
      'package.json': JSON.stringify({
        name: 'test-dep',
        version: '1.0.0',
        dependencies: {
          'kms-demo': '1.0.0',
        },
      }),
      node_modules: {
        'kms-demo': {
          'package.json': JSON.stringify({
            name: 'kms-demo',
            version: '1.0.0',
          }),
        },
      },
      'package-lock.json': JSON.stringify({
        name: 'test-dep',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        packages: {
          '': {
            name: 'scratch',
            version: '1.0.0',
            dependencies: {
              'kms-demo': '^1.0.0',
            },
          },
          'node_modules/kms-demo': {
            version: '1.0.0',
          },
        },
        dependencies: {
          'kms-demo': {
            version: '1.0.0',
          },
        },
      }),
    })
  }

  function installWithMultipleDeps () {
    return t.testdir({
      'package.json': JSON.stringify({
        name: 'test-dep',
        version: '1.0.0',
        dependencies: {
          'kms-demo': '^1.0.0',
        },
        devDependencies: {
          async: '~1.1.0',
        },
      }),
      node_modules: {
        'kms-demo': {
          'package.json': JSON.stringify({
            name: 'kms-demo',
            version: '1.0.0',
          }),
        },
        async: {
          'package.json': JSON.stringify({
            name: 'async',
            version: '1.1.1',
          }),
        },
      },
      'package-lock.json': JSON.stringify({
        name: 'test-dep',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        packages: {
          '': {
            name: 'scratch',
            version: '1.0.0',
            dependencies: {
              'kms-demo': '^1.0.0',
            },
            devDependencies: {
              async: '~1.0.0',
            },
          },
          'node_modules/kms-demo': {
            version: '1.0.0',
          },
          'node_modules/async': {
            version: '1.1.1',
          },
        },
        dependencies: {
          'kms-demo': {
            version: '1.0.0',
          },
        },
        devDependencies: {
          async: {
            version: '1.1.1',
          },
        },
      }),
    })
  }

  async function manifestWithValidSigs () {
    const manifest = registry.manifest({
      name: 'kms-demo',
      packuments: [{
        version: '1.0.0',
        dist: {
          tarball: 'https://registry.npmjs.org/kms-demo/-/kms-demo-1.0.0.tgz',
          integrity: 'sha512-QqZ7VJ/8xPkS9s2IWB7Shj3qTJdcRyeXKbPQnsZjsPEwvutGv0EGeVchPca' +
                     'uoiDFJlGbZMFq5GDCurAGNSghJQ==',
          signatures: [
            {
              keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
              sig: 'MEUCIDrLNspFeU5NZ6d55ycVBZIMXnPJi/XnI1Y2dlJvK8P1AiEAnXjn1IOMUd+U7YfPH' +
                   '+FNjwfLq+jCwfH8uaxocq+mpPk=',
            },
          ],
        },
      }],
    })
    await registry.package({ manifest })
  }

  async function manifestWithInvalidSigs () {
    const manifest = registry.manifest({
      name: 'kms-demo',
      packuments: [{
        version: '1.0.0',
        dist: {
          tarball: 'https://registry.npmjs.org/kms-demo/-/kms-demo-1.0.0.tgz',
          integrity: 'sha512-QqZ7VJ/8xPkS9s2IWB7Shj3qTJdcRyeXKbPQnsZjsPEwvutGv0EGeVchPca' +
                     'uoiDFJlGbZMFq5GDCurAGNSghJQ==',
          signatures: [
            {
              keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
              sig: 'MEUCIQCX/49atNeSDYZP8betYWEqB0G8zZnIyB7ibC7nRNyMiQIgHosOKHhVT' +
                   'VNBI/6iUNSpDokOc44zsZ7TfybMKj8YdfY=',
            },
          ],
        },
      }],
    })
    await registry.package({ manifest })
  }

  async function manifestWithoutSigs (name = 'kms-demo', version = '1.0.0') {
    const manifest = registry.manifest({
      name,
      packuments: [{
        version,
      }],
    })
    await registry.package({ manifest })
  }

  function validKeys () {
    registry.nock.get('/-/npm/v1/keys')
      .reply(200, {
        keys: [{
          expires: null,
          keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
          keytype: 'ecdsa-sha2-nistp256',
          scheme: 'ecdsa-sha2-nistp256',
          key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+' +
               'IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==',
        }],
      })
  }

  function mismatchingKeys () {
    registry.nock.get('/-/npm/v1/keys')
      .reply(200, {
        keys: [{
          expires: null,
          keyid: 'SHA256:2l3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
          keytype: 'ecdsa-sha2-nistp256',
          scheme: 'ecdsa-sha2-nistp256',
          key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+' +
               'IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==',
        }],
      })
  }

  function expiredKeys () {
    registry.nock.get('/-/npm/v1/keys')
      .reply(200, {
        keys: [{
          expires: '2021-01-11T15:45:42.144Z',
          keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
          keytype: 'ecdsa-sha2-nistp256',
          scheme: 'ecdsa-sha2-nistp256',
          key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+' +
               'IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==',
        }],
      })
  }

  t.test('with valid signatures', async t => {
    npm.prefix = validInstall()
    await manifestWithValidSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 0, 'should exit successfully')
    process.exitCode = 0
    t.match(joinedOutput(), /verified registry signatures, audited 1 packages/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('with invalid signatures', async t => {
    npm.prefix = validInstall()
    await manifestWithInvalidSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(joinedOutput(), /invalid/)
    t.match(joinedOutput(), /kms-demo@1.0.0/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('with valid and missing signatures', async t => {
    npm.prefix = installWithMultipleDeps()
    await manifestWithValidSigs()
    await manifestWithoutSigs('async', '1.1.1')
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(joinedOutput(), /audited 2 packages/)
    t.match(joinedOutput(), /verified/)
    t.match(joinedOutput(), /missing/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('with both invalid and missing signatures', async t => {
    npm.prefix = installWithMultipleDeps()
    await manifestWithInvalidSigs()
    await manifestWithoutSigs('async', '1.1.1')
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(joinedOutput(), /audited 2 packages/)
    t.match(joinedOutput(), /invalid/)
    t.match(joinedOutput(), /missing/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('with signatures but no public keys', async t => {
    npm.prefix = validInstall()
    await manifestWithValidSigs()
    registry.nock.get('/-/npm/v1/keys')
      .reply(404)

    await t.rejects(
      audit.exec(['signatures']),
      /no corresponding public key can be found on https:\/\/registry.npmjs.org\/-\/npm\/v1\/keys/,
      'should throw with error'
    )
  })

  t.test('with signatures but the public keys are expired', async t => {
    npm.prefix = validInstall()
    await manifestWithValidSigs()
    expiredKeys()

    await t.rejects(
      audit.exec(['signatures']),
      /the corresponding public key on https:\/\/registry.npmjs.org\/-\/npm\/v1\/keys has expired/,
      'should throw with error'
    )
  })

  t.test('with signatures but the public keyid does not match', async t => {
    npm.prefix = validInstall()
    await manifestWithValidSigs()
    mismatchingKeys()

    await t.rejects(
      audit.exec(['signatures']),
      /no corresponding public key can be found on https:\/\/registry.npmjs.org\/-\/npm\/v1\/keys/,
      'should throw with error'
    )
  })

  t.test('with keys but missing signature', async t => {
    npm.prefix = validInstall()
    await manifestWithoutSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(
      joinedOutput(),
      /registry is providing signing keys/
    )
    t.matchSnapshot(joinedOutput())
  })

  t.test('output details about missing signatures', async t => {
    npm.prefix = validInstall()
    npm.config.set('missing', true)
    await manifestWithoutSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(
      joinedOutput(),
      /kms-demo/
    )
    t.matchSnapshot(joinedOutput())
  })

  t.test('json output with valid signatures', async t => {
    npm.prefix = validInstall()
    npm.config.set('json', true)
    await manifestWithValidSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 0, 'should exit successfully')
    process.exitCode = 0
    t.match(joinedOutput(), /{}/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('json output with invalid signatures', async t => {
    npm.prefix = validInstall()
    npm.config.set('json', true)
    await manifestWithInvalidSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(joinedOutput(), /"invalid": {\n\s+"node_modules\/kms-demo": {/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('json output with invalid and missing signatures', async t => {
    npm.prefix = installWithMultipleDeps()
    npm.config.set('json', true)
    await manifestWithInvalidSigs()
    await manifestWithoutSigs('async', '1.1.1')
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 1, 'should exit with error')
    process.exitCode = 0
    t.match(joinedOutput(), /"invalid": {\n\s+"node_modules\/kms-demo": {/)
    t.match(joinedOutput(), /"missing": {\n\s+"node_modules\/async": {/)
    t.matchSnapshot(joinedOutput())
  })

  t.test('omit dev dependencies with missing signature', async t => {
    npm.prefix = installWithMultipleDeps()
    npm.config.set('omit', ['dev'])
    await manifestWithValidSigs()
    validKeys()

    await audit.exec(['signatures'])

    t.equal(process.exitCode, 0, 'should exit successfully')
    process.exitCode = 0
    t.match(joinedOutput(), /verified registry signatures, audited 1 packages/)
    t.matchSnapshot(joinedOutput())
  })
})

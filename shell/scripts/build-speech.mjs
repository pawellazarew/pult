// Pinned, static whisper.cpp runtime. Only build machines need CMake and a C++ compiler.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build/speech')
const revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
const stamp = `${revision}-${process.platform}-${process.arch}-mac12`
if (existsSync(join(out, 'version')) && readFileSync(join(out, 'version'), 'utf8') === stamp && existsSync(join(out, 'whisper-cli'))) process.exit(0)
mkdirSync(out, { recursive: true })
const cache = join(root, '.speech-build')
mkdirSync(cache, { recursive: true })
const archive = join(cache, 'source.tar.gz')
if (!existsSync(archive)) {
  const response = await fetch(`https://github.com/ggml-org/whisper.cpp/archive/${revision}.tar.gz`)
  if (!response.ok) throw new Error(`whisper source: HTTP ${response.status}`)
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4') throw new Error('whisper source checksum mismatch')
execFileSync('tar', ['-xzf', archive, '-C', cache], { stdio: 'inherit' })
const source = join(cache, `whisper.cpp-${revision}`)
const build = join(cache, 'build')
execFileSync('cmake', ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', ...(process.platform === 'darwin' ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'] : []), '-DBUILD_SHARED_LIBS=OFF', '-DGGML_METAL=OFF', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF'], { stdio: 'inherit' })
execFileSync('cmake', ['--build', build, '--target', 'whisper-cli', '-j', '4'], { stdio: 'inherit' })
copyFileSync(join(build, 'bin/whisper-cli'), join(out, 'whisper-cli'))
copyFileSync(join(source, 'LICENSE'), join(out, 'whisper-LICENSE.txt'))
// The release's root LICENSE covers whisper and its embedded ggml sources.
writeFileSync(join(out, 'version'), stamp)

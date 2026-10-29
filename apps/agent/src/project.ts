import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

// Create a project from a .zip uploaded by the member: the server streams the zip here in chunks, then asks us to
// extract it (SAFELY — untrusted archive) into the new project folder and make it a git repo, all as the member.
const run = promisify(execFile)
const srv = () => (process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash').replace(/\\/g, '/')
// Temp zips and extraction dirs live next to the project folders (same filesystem, so the final move is atomic).
const tmpRoot = () => `${srv()}/projects/.dd-uploads`
// Project path must be <root>/projects/<slug>; same shape git.ts accepts.
const destRe = () => new RegExp(`^${srv().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects/[a-z0-9][a-z0-9-]{0,39}$`)
const ID_RE = /^[a-f0-9]{8,64}$/

const GB = 1024 ** 3
/** The biggest project a .zip may bring: the archive itself, and what it unpacks to. */
export const MAX_BYTES = 20 * GB
const MAX_FILES = 250_000
const MAX_RATIO = 200 // uncompressed/compressed guard against zip bombs
/** Room every upload leaves free on the shared disk, for everyone else's work. */
export const DISK_SPARE = 5 * GB

const gb = (n: number) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`
/** Whether `need` more bytes fit while keeping DISK_SPARE free; the reason why not, for the person uploading. */
export function roomFor(free: number, need: number, what: string): string | null {
  if (free - need >= DISK_SPARE) return null
  return `Not enough free space on the server to ${what} (needs about ${gb(need + DISK_SPARE)}, ${gb(free)} free). Ask an admin to make room.`
}
const freeBytes = async (dir: string) => {
  const s = await statfs(dir)
  return s.bavail * s.bsize
}

/** Uploads arriving here (upload id → when its last piece came) and archives being unpacked: a deploy's restart waits. */
const arriving = new Map<string, number>()
let unpacking = 0
/** Imports in progress by upload id: asking again (the server restarted and forgot) joins the one already running. */
const importing = new Map<string, Promise<{ defaultBranch: string }>>()
/** Written into a finished import's .git, so asking again after a lost answer says it's done instead of failing. */
const MARKER = 'devdash-import'
const QUIET_MS = 2 * 60_000
/** Whether an upload is in progress (a piece in the last two minutes) or an archive is being unpacked (main.ts). */
export function busy(now = Date.now()) {
  for (const [id, at] of arriving) if (now - at > QUIET_MS) arriving.delete(id)
  return unpacking > 0 || arriving.size > 0
}

const checkedId = (v: unknown) => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error('bad upload id')
  return v
}
const zipPath = (id: string) => join(tmpRoot(), `${id}.zip`)

async function gitIdentity(cwd: string) {
  const email = await run('git', ['-C', cwd, 'config', 'user.email']).then((r) => r.stdout.trim()).catch(() => '')
  if (email) return []
  const me = userInfo().username
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@users.noreply.devdash`]
}

// Resolve every symlink under dir and make sure none escapes it (a zip can smuggle a link to /etc, etc.).
async function noEscapingLinks(dir: string, root: string) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name)
    const s = await lstat(p)
    if (s.isSymbolicLink()) {
      const real = await realpath(p).catch(() => null)
      if (!real || (real !== root && !real.startsWith(`${root}/`))) throw new Error('The .zip contains a link pointing outside the project. It was not imported.')
    } else if (s.isDirectory()) {
      await noEscapingLinks(p, root)
    }
  }
}

export const ops = {
  /**
   * One chunk of the uploaded zip. offset 0 starts it over (and says how big the whole file is, so a zip that's too big
   * or doesn't fit on the disk is refused before it uploads); chunks arrive in order (same shape as fs.write).
   */
  async zipChunk(r: Record<string, unknown>) {
    const id = checkedId(r.id)
    const offset = Number(r.offset) || 0
    const data = Buffer.from(String(r.data ?? ''), 'base64')
    if (offset + data.length > MAX_BYTES) throw new Error(`That .zip is over ${gb(MAX_BYTES)}.`)
    await mkdir(tmpRoot(), { recursive: true })
    if (offset === 0) {
      const total = Number(r.total) || data.length
      if (total > MAX_BYTES) throw new Error(`That .zip is over ${gb(MAX_BYTES)}.`)
      const full = roomFor(await freeBytes(tmpRoot()), total, 'upload this .zip')
      if (full) throw new Error(full)
    }
    arriving.set(id, Date.now()) // only an accepted upload holds off a restart
    const fh = await open(zipPath(id), offset === 0 ? 'w' : 'r+')
    try {
      await fh.write(data, 0, data.length, offset)
    } finally {
      await fh.close()
    }
    return { ok: true, size: offset + data.length }
  },

  /** Throw away a half-finished upload (the member closed the dialog or the finalize failed). */
  async zipAbort(r: Record<string, unknown>) {
    arriving.delete(checkedId(r.id))
    await rm(zipPath(checkedId(r.id)), { force: true }).catch(() => {})
    return { ok: true }
  },

  /**
   * Unzip the uploaded archive into a NEW empty project folder and git-init it, as the member.
   * Safe against path traversal, absolute paths, escaping symlinks and zip bombs; runs no code from the archive.
   * Asking again for the same upload (the server restarted mid-import and lost the answer) is safe: it joins the import
   * still running, or reports the finished one.
   */
  async fromZip(r: Record<string, unknown>) {
    const id = checkedId(r.id)
    const dest = String(r.dest ?? '').replace(/\\/g, '/')
    if (!destRe().test(dest)) throw new Error('not a DevDash project folder')
    arriving.delete(id) // the upload is over, however the import goes
    const running = importing.get(id)
    if (running) return running
    // Registered before the first await, so a second ask arriving meanwhile joins this one instead of racing it.
    const p = (async () => {
      if ((await readFile(join(dest, '.git', MARKER), 'utf8').catch(() => '')).trim() === id) return { defaultBranch: 'main' }
      return importZip(id, dest)
    })()
    importing.set(id, p)
    try {
      return await p
    } finally {
      if (importing.get(id) === p) importing.delete(id)
    }
  },
}

function parseZipBuffer(buf: Buffer): { name: string; data: Buffer; isDir: boolean }[] {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of buffer
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid .zip archive.')
  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  if (cdOffset + cdSize > buf.length) throw new Error('Corrupted .zip central directory.')

  const entries: { name: string; data: Buffer; isDir: boolean }[] = []
  let ptr = cdOffset
  for (let i = 0; i < totalEntries && ptr < cdOffset + cdSize; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Corrupted .zip central directory entry.')
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const uncompSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localHeaderOffset = buf.readUInt32LE(ptr + 42)
    const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8').replace(/\\/g, '/')
    ptr += 46 + nameLen + extraLen + commentLen

    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('Corrupted .zip local header.')
    const lNameLen = buf.readUInt16LE(localHeaderOffset + 26)
    const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen
    const compData = buf.subarray(dataStart, dataStart + compSize)

    const isDir = rawName.endsWith('/')
    let data: Buffer = Buffer.alloc(0)
    if (!isDir && compSize > 0) {
      if (method === 0) {
        data = Buffer.from(compData)
      } else if (method === 8) {
        data = inflateRawSync(compData, { maxOutputLength: Math.max(uncompSize + 1024, 1024 * 1024) })
      } else {
        throw new Error(`Unsupported .zip compression method: ${method}`)
      }
    }
    entries.push({ name: rawName, data, isDir })
  }
  return entries
}

async function importZip(id: string, dest: string) {
  if (existsSync(dest) && (await readdir(dest).catch(() => [])).length) throw new Error('That folder already exists on the server.')
  const zip = zipPath(id)
  if (!existsSync(zip)) throw new Error('The upload did not arrive. Try again.')
  const work = join(tmpRoot(), `${id}.x`)
  let made = false // only ever clean up a dest folder we created ourselves
  unpacking++
  try {
    const hasUnzip = await run('unzip', ['-v'], { timeout: 3000 }).then(() => true, () => false)
    if (hasUnzip) {
      // 1. Vet entry names before touching the disk: no absolute paths, no `..` segments. (zip is our own controlled temp path.)
      const names = (await run('unzip', ['-Z', '-1', zip], { maxBuffer: 256 * 1024 * 1024 })).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      if (!names.length) throw new Error('That .zip is empty.')
      for (const n of names) {
        if (n.startsWith('/') || n.split('/').some((seg) => seg === '..')) throw new Error('The .zip contains unsafe paths. It was not imported.')
      }
      // 2. Size/bomb guard from the archive listing: total uncompressed bytes and file count.
      const listing = (await run('unzip', ['-l', zip], { maxBuffer: 256 * 1024 * 1024 })).stdout
      const summary = listing.trim().split('\n').pop()!.match(/^\s*(\d+)\s+(\d+)\s+files?/)
      const totalBytes = summary ? Number(summary[1]) : 0
      const count = summary ? Number(summary[2]) : names.length
      const compressed = (await lstat(zip)).size
      if (count > MAX_FILES) throw new Error('That .zip has too many files.')
      if (totalBytes > MAX_BYTES) throw new Error(`That .zip is too large once unpacked (over ${gb(MAX_BYTES)}).`)
      if (compressed > 0 && totalBytes / compressed > MAX_RATIO && totalBytes > 50 * 1024 ** 2) throw new Error('That .zip looks like a zip bomb. It was not imported.')
      const full = roomFor(await freeBytes(tmpRoot()), totalBytes * 2, 'unpack this .zip')
      if (full) throw new Error(full)
      // 3. Extract into a fresh temp dir, never over existing files (-n), no interpreter or build step involved.
      await rm(work, { recursive: true, force: true })
      await mkdir(work, { recursive: true })
      await run('unzip', ['-qq', '-n', zip, '-d', work], { timeout: 60 * 60_000, maxBuffer: 16 * 1024 * 1024 })
    } else {
      const zipBuf = await readFile(zip)
      const entries = parseZipBuffer(zipBuf)
      if (!entries.length) throw new Error('That .zip is empty.')
      let totalBytes = 0
      for (const e of entries) {
        if (e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || e.name.split('/').some((seg) => seg === '..')) {
          throw new Error('The .zip contains unsafe paths. It was not imported.')
        }
        totalBytes += e.data.length
      }
      if (entries.length > MAX_FILES) throw new Error('That .zip has too many files.')
      if (totalBytes > MAX_BYTES) throw new Error(`That .zip is too large once unpacked (over ${gb(MAX_BYTES)}).`)
      if (zipBuf.length > 0 && totalBytes / zipBuf.length > MAX_RATIO && totalBytes > 50 * 1024 ** 2) {
        throw new Error('That .zip looks like a zip bomb. It was not imported.')
      }
      const full = roomFor(await freeBytes(tmpRoot()), totalBytes * 2, 'unpack this .zip')
      if (full) throw new Error(full)
      await rm(work, { recursive: true, force: true })
      await mkdir(work, { recursive: true })
      for (const e of entries) {
        const target = join(work, e.name)
        if (e.isDir) {
          await mkdir(target, { recursive: true })
        } else {
          await mkdir(dirname(target), { recursive: true })
          if (!existsSync(target)) await writeFile(target, e.data)
        }
      }
    }
    // 4. Belt-and-braces: resolve symlinks and confirm none escape the extraction dir.
    const workReal = await realpath(work)
    await noEscapingLinks(workReal, workReal)
    // 5. Flatten a lone top-level folder (common: `myapp/...`) so the project holds the files directly.
    let content = workReal
    const top = await readdir(workReal)
    if (top.length === 1 && (await lstat(join(workReal, top[0]!))).isDirectory()) content = join(workReal, top[0]!)
    // 6. Move into place, then make it a shared git repo with one import commit (so worktrees/branches work).
    await mkdir(`${srv()}/projects`, { recursive: true }).catch(() => {})
    await rename(content, dest)
    made = true
    const initArgs = process.platform === 'win32'
      ? ['init', '--quiet', '--initial-branch=main', dest]
      : ['init', '--quiet', '--initial-branch=main', '--shared=group', dest]
    await run('git', initArgs)
    await run('git', ['-C', dest, ...(await gitIdentity(dest)), 'add', '-A'])
    await run('git', ['-C', dest, ...(await gitIdentity(dest)), 'commit', '--quiet', '--allow-empty', '-m', 'Import project'])
    await writeFile(join(dest, '.git', MARKER), `${id}\n`)
    return { defaultBranch: 'main' }
  } catch (err) {
    if (made) await rm(dest, { recursive: true, force: true }).catch(() => {}) // never leave a half-made folder
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    unpacking--
    await rm(work, { recursive: true, force: true }).catch(() => {})
    await rm(zip, { force: true }).catch(() => {}) // the uploaded zip is done with, success or not
  }
}

// Who is on the other end of a local socket, and whose child that process is,
// as the kernel reports them (macOS: LOCAL_PEERPID and proc_pidinfo).
import { dlopen, ptr } from 'bun:ffi'
import type { Socket } from 'net'

const SOL_LOCAL = 0
const LOCAL_PEERPID = 2
const PROC_PIDTBSDINFO = 3
const BSDINFO_SIZE = 136
const PPID_OFFSET = 16

const libc = dlopen('/usr/lib/libSystem.B.dylib', {
  getsockopt: { args: ['i32', 'i32', 'i32', 'ptr', 'ptr'], returns: 'i32' },
  proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
})

/** The pid of the process that connected, or undefined when the kernel will not say. */
export function peerPid(socket: Socket): number | undefined {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number' || fd < 0) return undefined
  const value = new Int32Array(1)
  const length = new Uint32Array([4])
  if (libc.symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(value), ptr(length)) !== 0) return undefined
  return value[0] > 0 ? value[0] : undefined
}

export function parentPid(pid: number): number | undefined {
  const info = new Uint8Array(BSDINFO_SIZE)
  if (libc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE) return undefined
  return new DataView(info.buffer).getUint32(PPID_OFFSET, true)
}

/** The pid and its parents, nearest first, up to launchd. */
export function ancestry(pid: number, parentOf: (pid: number) => number | undefined = parentPid): number[] {
  const chain = [pid]
  for (let current = pid; chain.length < 64; ) {
    const parent = parentOf(current)
    if (!parent || parent === current || chain.includes(parent)) break
    chain.push(parent)
    current = parent
  }
  return chain
}

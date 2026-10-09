import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { privateIpcSeccomp } from "../lib/private-ipc-seccomp.mjs";

// Minimal classic-BPF interpreter: exercise decisions, not serialized bytes.
function verdict(program, arch, syscall, family = 0) {
  const data = new Map([[0, syscall >>> 0], [4, arch >>> 0], [16, family >>> 0]]);
  let accumulator = 0;
  for (let pc = 0; pc < program.length / 8; pc++) {
    const offset = pc * 8, code = program.readUInt16LE(offset), jt = program[offset + 2], jf = program[offset + 3], k = program.readUInt32LE(offset + 4);
    if (code === 0x20) { assert.ok(data.has(k)); accumulator = data.get(k); }
    else if (code === 0x15) pc += accumulator === k ? jt : jf;
    else if (code === 0x35) pc += accumulator >= k ? jt : jf;
    else if (code === 0x06) return k;
    else assert.fail(`Unexpected BPF instruction ${code}`);
  }
  assert.fail("Filter fell through without a verdict");
}

test("private IPC permits Unix sockets and ordinary I/O, denying IP, VM sockets and syscall bypasses on both ABIs", () => {
  for (const [arch, abi, socket, pair, denied, ordinary] of [
    ["x64", 0xc000003e, 41, 53, [101, 248, 249, 250, 298, 304, 310, 311, 321, 425, 426, 427], [0, 1, 2, 3, 42, 43, 49, 50, 60]],
    ["arm64", 0xc00000b7, 198, 199, [117, 217, 218, 219, 241, 265, 270, 271, 280, 425, 426, 427], [56, 57, 63, 64, 93, 200, 201, 202, 203]],
  ]) {
    const program = privateIpcSeccomp(arch);
    for (const nr of [socket, pair]) {
      assert.equal(verdict(program, abi, nr, 1), 0x7fff0000, `${arch}: AF_UNIX`);
      for (const family of [0, 2, 10, 16, 17, 40, 0xffffffff]) assert.equal(verdict(program, abi, nr, family), 0x50001, `${arch}: family ${family}`);
    }
    for (const nr of denied) assert.equal(verdict(program, abi, nr), 0x50001);
    for (const nr of ordinary) assert.equal(verdict(program, abi, nr), 0x7fff0000);
    for (const foreign of [0, 0x40000003, arch === "x64" ? 0xc00000b7 : 0xc000003e]) assert.equal(verdict(program, foreign, socket, 1), 0x80000000);
    if (arch === "x64") for (const nr of [0x40000000, 0x40000029, 0xffffffff]) assert.equal(verdict(program, abi, nr, 1), 0x50001);
  }
  assert.throws(() => privateIpcSeccomp("ia32"), /supports/);
});

test("Linux accepts the compiled seccomp program without relaxing the surrounding sandbox", { skip: process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || !existsSync("/usr/bin/python3") }, () => {
  const code = `import ctypes, base64, socket, errno
class Filter(ctypes.Structure):
 _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
class Program(ctypes.Structure):
 _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
data = base64.b64decode('${privateIpcSeccomp().toString("base64")}')
filters = (Filter * (len(data) // 8)).from_buffer_copy(data)
program = Program(len(filters), filters)
libc = ctypes.CDLL(None, use_errno=True)
assert libc.prctl(38, 1, 0, 0, 0) == 0, ctypes.get_errno()
assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0, ctypes.get_errno()
for family in [socket.AF_INET, socket.AF_INET6, 40]:
 try:
  socket.socket(family)
  raise AssertionError('forbidden socket created')
 except OSError as error: assert error.errno == errno.EPERM, error
`;
  const result = spawnSync("/usr/bin/python3", ["-c", code], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr?.toString());
});

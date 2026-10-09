// Linux classic BPF, struct seccomp_data offsets: nr=0, arch=4, args[0]=16.
// Syscall numbers: asm/unistd_64.h and asm-generic/unistd.h (AArch64).
// Restrict socket families even inside a network namespace: AF_VSOCK can be a
// host bridge, and io_uring can create sockets without calling socket(2).
export function privateIpcSeccomp(arch = process.arch) {
  const abi = {
    x64: { audit: 0xc000003e, socket: 41, socketpair: 53, denied: [101, 248, 249, 250, 298, 304, 310, 311, 321, 425, 426, 427] },
    arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, denied: [117, 217, 218, 219, 241, 265, 270, 271, 280, 425, 426, 427] },
  }[arch];
  if (!abi) throw new Error("Private IPC seccomp supports Linux x86-64 and AArch64 only");
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
  const DENY = 0x00050001, ALLOW = 0x7fff0000, KILL = 0x80000000;
  const instructions = [[LD, 0, 0, 4], [JEQ, 1, 0, abi.audit], [RET, 0, 0, KILL], [LD, 0, 0, 0]];
  // x32 uses the same audit architecture but different syscall numbers.
  if (arch === "x64") instructions.push([JGE, 0, 1, 0x40000000], [RET, 0, 0, DENY]);
  for (const nr of abi.denied) instructions.push([JEQ, 0, 1, nr], [RET, 0, 0, DENY]);
  instructions.push([JEQ, 1, 0, abi.socket], [JEQ, 0, 3, abi.socketpair],
    [LD, 0, 0, 16], [JEQ, 1, 0, 1], [RET, 0, 0, DENY], [RET, 0, 0, ALLOW]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = jt; bytes[i * 8 + 3] = jf; bytes.writeUInt32LE(k, i * 8 + 4);
  });
  return bytes;
}

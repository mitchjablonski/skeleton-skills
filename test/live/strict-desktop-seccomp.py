"""Fixed x86_64 seccomp policy used by the display isolation fixtures."""

import struct

AF_VSOCK = 40
NR_SOCKET, NR_IO_URING_SETUP = 41, 425
EAFNOSUPPORT, ENOSYS = 97, 38


def seccomp_program():
    """x86_64 BPF: refuse socket(AF_VSOCK) and io_uring_setup; kill other ABIs."""
    def ins(code, jt, jf, k):
        return struct.pack("HBBI", code, jt, jf, k)
    LD_ABS, JEQ, JGE, RET = 0x20, 0x15, 0x35, 0x06
    KILL, ALLOW, ERRNO = 0x80000000, 0x7FFF0000, 0x00050000
    prog = [
        ins(LD_ABS, 0, 0, 4),                 # 0 arch
        ins(JEQ, 1, 0, 0xC000003E),           # 1 x86_64 -> 3
        ins(RET, 0, 0, KILL),                 # 2
        ins(LD_ABS, 0, 0, 0),                 # 3 nr
        ins(JGE, 0, 1, 0x40000000),           # 4 x32 ABI -> kill
        ins(RET, 0, 0, KILL),                 # 5
        ins(JEQ, 0, 1, NR_IO_URING_SETUP),    # 6
        ins(RET, 0, 0, ERRNO | ENOSYS),       # 7
        ins(JEQ, 0, 3, NR_SOCKET),            # 8 not socket -> 12
        ins(LD_ABS, 0, 0, 16),                # 9 args[0] low word (domain is an int)
        ins(JEQ, 0, 1, AF_VSOCK),             # 10
        ins(RET, 0, 0, ERRNO | EAFNOSUPPORT), # 11
        ins(RET, 0, 0, ALLOW),                # 12
    ]
    return b"".join(prog)

import {bindSeatMetadata} from './strict-seat-metadata.mjs';

// Fixed owned-window fixture. These are synthetic observations, regardless of
// which desktop or namespace the fixture process actually runs in.
export function makeSeatFixture() {
  let socketInode = 3n;
  let readable = true;
  const binding = bindSeatMetadata({
    display: () => ':0',
    mountInfo: () => {
      if (!readable) throw new Error('fixture seat unavailable');
      return '81 80 0:38 / /mnt/wslg rw - tmpfs none rw\n128 80 0:38 /.X11-unix /tmp/.X11-unix ro - tmpfs none rw\n';
    },
    lstat(file) {
      const socket = file.endsWith('/X0');
      const inode = socket ? socketInode : file === '/mnt/wslg' ? 1n : 2n;
      return {dev: 38n, ino: inode, ctimeNs: 1n, isSocket: () => socket, isDirectory: () => !socket};
    },
    readlink: (file) => `${file.split('/').at(-1)}:[1]`,
  });
  return {
    binding,
    withdraw() { readable = false; },
    replace() { socketInode++; },
  };
}

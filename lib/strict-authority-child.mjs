// Disabled host adapter. The launcher supplies validated enrollment and owns
// descriptor provenance. Its supervisor must prove physical stop before recovery.
import { openCaptureStore } from './strict-capture-store.mjs';
import { openHumanAuthorityHistory, openHumanAuthorityStore } from './strict-human-authority-store.mjs';
import { createHumanCommandServer } from './strict-human-channel.mjs';

const RECOVERY_INPUT_BYTES = 1024;
const RECOVERY_INPUT_TIMEOUT_MS = 1000;
const unavailable = Object.freeze({ kind: 'rejected', code: 'unavailable' });

/** Attach the existing server only after successfully opening the selected enrollment. */
export function serveHumanAuthorityChild(endpoint, enrollment, protectedEffects) {
  try {
    const { authorityDirectory, captureDirectory, expectedContext } = enrollment;
    const captureStore = openCaptureStore(captureDirectory);
    const authority = openHumanAuthorityStore(authorityDirectory, expectedContext, {
      ...protectedEffects,
      captureStore,
    });
    return createHumanCommandServer(endpoint, authority);
  } catch {
    endpoint.destroy();
    throw Error('authority child unavailable');
  }
}

/** One retained request on a distinct binary input that this recovery leaf owns. */
export async function recoverHumanAuthorityChild(input, enrollment) {
  const deadline = setTimeout(() => input.destroy(Error('recovery input expired')), RECOVERY_INPUT_TIMEOUT_MS);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk) || size + chunk.length > RECOVERY_INPUT_BYTES) return unavailable;
      chunks.push(chunk);
      size += chunk.length;
    }

    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
    const request = JSON.parse(text);
    if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'operation') || !Object.hasOwn(request, 'args')
        || JSON.stringify(request) !== text) return unavailable;

    const { authorityDirectory, captureDirectory, expectedContext } = enrollment;
    const captureStore = openCaptureStore(captureDirectory);
    const history = openHumanAuthorityHistory(authorityDirectory, expectedContext, { captureStore });
    return history.lookup(request.operation, request.args);
  } catch {
    return unavailable;
  } finally {
    clearTimeout(deadline);
    input.destroy();
  }
}

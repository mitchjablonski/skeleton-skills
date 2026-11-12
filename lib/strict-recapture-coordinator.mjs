// Trusted host orchestration only. No authentication, enumeration, freeze,
// enrollment, activation, rollback/GC or atomic authority/blob transaction.
// The host injects protected handles and independently observed capture data.
import { parseStrictIntent, parseStrictResult } from './strict-protocol.mjs';
import { validateStoredCapture } from './strict-capture.mjs';

const unavailable = () => Object.freeze({ kind: 'rejected', code: 'unavailable' });
function request(value) {
  const intent = parseStrictIntent(value);
  return intent?.protocolVersion === 2 && intent.action === 'recapture' ? intent : null;
}
function resolve(store, shape, identity) {
  const capture = validateStoredCapture(store.get(identity));
  if (capture.captureVersion !== identity || capture.shapeVersion !== shape) throw Error('capture binding mismatch');
  return capture;
}
function answer(store, value, intent) {
  const result = parseStrictResult(value);
  if (!result) return unavailable();
  if (result.kind === 'rejected') return !Object.hasOwn(result, 'requestId') || result.requestId === intent.requestId ? result : unavailable();
  if (result.kind !== 'recaptured' || result.protocolVersion !== 2 || result.action !== 'recapture' || result.requestId !== intent.requestId) return unavailable();
  if (result.revision !== intent.expectedRevision + (result.changed ? 1 : 0)) return unavailable();
  if (!result.changed && (result.reviewVersion !== intent.reviewVersion || result.captureVersion !== intent.captureVersion)) return unavailable();
  // Exact dedupe can return an older pair, not the newly published capture.
  resolve(store, result.reviewVersion, result.captureVersion);
  return result;
}

/** Handles must be host-owned synchronous store adapters, never request data.
 * Store exceptions and malformed answers mean unavailable/unknown outcome.
 * Stop and reconcile storage health before retrying; never mint a replacement ID.
 */
export function createRecaptureCoordinator({ authorityStore, captureStore }) {
  return Object.freeze({
    recapture(value, independentlyCaptured) {
      try {
        const intent = request(value);
        if (!intent) return unavailable();
        const capture = validateStoredCapture(independentlyCaptured);
        resolve(captureStore, intent.reviewVersion, intent.captureVersion);
        const published = validateStoredCapture(captureStore.put(capture));
        if (published.shapeVersion !== capture.shapeVersion || published.captureVersion !== capture.captureVersion) return unavailable();
        const result = authorityStore.submit(intent, Object.freeze({ contentVersion: published.shapeVersion,
          captureVersion: published.captureVersion, nextReviewRoundId: null, completionVerified: false }));
        return answer(captureStore, result, intent);
      } catch { return unavailable(); }
    },
    retry(value) {
      try {
        const intent = request(value);
        if (!intent) return unavailable();
        resolve(captureStore, intent.reviewVersion, intent.captureVersion);
        // Never interpret unavailable as a preflight permission to recapture.
        return answer(captureStore, authorityStore.submit(intent, null), intent);
      } catch { return unavailable(); }
    },
  });
}

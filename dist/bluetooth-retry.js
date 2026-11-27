export const RETRY_DELAYS = [350, 850, 1700];

const cancelled = () => new DOMException('Cancelled', 'AbortError');
const choosers = new WeakSet();

export function chooseBluetoothDevice(options) {
  const bluetooth = navigator.bluetooth;
  if (choosers.has(bluetooth)) throw new DOMException('The Bluetooth device chooser is already open', 'ChooserBusyError');
  const selection = bluetooth.requestDevice(options);
  choosers.add(bluetooth);
  return Promise.resolve(selection).finally(() => choosers.delete(bluetooth));
}

export function bluetoothTimeout(signal, ms) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('Bluetooth operation timed out','TimeoutError')),ms);
  return {signal:AbortSignal.any([signal,timeout.signal]),clear:() => clearTimeout(timer)};
}

export function selectBluetoothDevice(options, signal) {
  const timeout = bluetoothTimeout(signal,45000);
  return bluetoothStep(() => chooseBluetoothDevice(options),timeout.signal).finally(timeout.clear);
}

export function bluetoothStep(operation, signal, discard) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? cancelled()); return; }
    const abort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener('abort', abort, {once:true});
    const cleanup = () => signal.removeEventListener('abort', abort);
    // requestDevice needs to run synchronously under the user's click.
    try {
      Promise.resolve(operation()).then(value => {
        cleanup();
        if (signal.aborted) {
          try { discard?.(value); } catch { /* The cancelled operation has already ended for the caller. */ }
          return;
        }
        resolve(value);
      }, error => { cleanup(); reject(error); });
    } catch (error) { cleanup(); reject(error); }
  });
}

export function bluetoothDelay(ms, signal) {
  let timer;
  return bluetoothStep(() => new Promise(resolve => { timer = setTimeout(resolve,ms); }),signal)
    .finally(() => clearTimeout(timer));
}

export function transientBluetoothError(error) {
  return error.name === 'NetworkError';
}

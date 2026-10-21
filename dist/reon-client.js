import {
  CHARACTERISTIC,
  DEVICE_INFO,
  SERVICE,
  parseAutomation,
  parseBattery,
  parseCapabilities,
  parseMode,
  parseTagAdvertisement,
  parseTemperature,
  SONY_COMPANY_ID,
  tagRegistrationFrame,
  tagUnregistrationFrame,
  toHex,
} from "./protocol.js";
import { bluetoothProblem, connectionError } from './bluetooth-environment.js';
import { readable, writable, optionalUnsupported, characteristicProperties, writeCharacteristic } from './gatt.js';

const OWNER_KEY_STORAGE = "reon-owner-key";
const TAG_ADDRESS_STORAGE = "reon-tag-address";

function ownerKey() {
  const stored = localStorage.getItem(OWNER_KEY_STORAGE);
  if (stored && /^[0-9a-f]{32}$/i.test(stored)) {
    return Uint8Array.from(stored.match(/.{2}/g), (byte) =>
      Number.parseInt(byte, 16),
    );
  }

  const key = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < key.length; index += 1) {
    key[index] %= 255;
  }
  localStorage.setItem(OWNER_KEY_STORAGE, toHex(key).replaceAll(" ", ""));
  return key;
}

async function readText(service, characteristicId) {
  const characteristic = await service.getCharacteristic(characteristicId);
  const value = await characteristic.readValue();
  return new TextDecoder().decode(value).replaceAll("\0", "");
}

function receiveTagAdvertisement(device) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      controller.abort();
      reject(new Error("Tag broadcast timed out"));
    }, 15000);
    const finish = (result, error) => {
      window.clearTimeout(timeout);
      controller.abort();
      if (error) reject(error);
      else resolve(result);
    };
    device.addEventListener(
      "advertisementreceived",
      (event) => {
        const value = event.manufacturerData.get(SONY_COMPANY_ID);
        const tag = value ? parseTagAdvertisement(value) : null;
        if (tag) finish(tag);
      },
      { signal: controller.signal },
    );
    device
      .watchAdvertisements({ signal: controller.signal })
      .catch((error) => finish(null, error));
  });
}

export class ReonClient {
  #device;
  #characteristics = {};
  #listeners = new Set();
  #writeQueue = Promise.resolve();
  #generation = 0;
  #connectionAttempt = 0;
  #connectionAbort = null;
  #pollTimer = null;
  #refreshing = false;
  #unreadable = new Set();
  #canRead(name) { return readable(this.#characteristics[name]) && !this.#unreadable.has(name); }
  #stopPolling() { if (this.#pollTimer !== null) window.clearInterval(this.#pollTimer); this.#pollTimer = null; }
  #onDisconnect = (event) => {
    if (event?.target && event.target !== this.#device) return;
    this.#stopPolling();
    this.#connectionAbort?.abort(new DOMException('Connection lost', 'NetworkError'));
    this.#generation++;
    this.#characteristics = {};
    this.#update({ connected: false, connecting: false, mode: null, tag: null });
  };

  state = {
    connected: false,
    connecting: false,
    connectionStage: 'idle',
    device: null,
    capabilities: null,
    mode: null,
    battery: null,
    temperature: null,
    tag: null,
    autoStart: null,
    quickLaunch: null,
    tagLinked: Boolean(localStorage.getItem(TAG_ADDRESS_STORAGE)),
    pairingTag: false,
    error: null,
    connectionDetail: null,
    connectionWarnings: [],
  };

  onState(listener) {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  #update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.#listeners) {
      listener(this.state);
    }
  }

  #log(direction, name, value) {
    document.dispatchEvent(
      new CustomEvent("reon-log", {
        detail: { direction, name, hex: value ? toHex(value) : "" },
      }),
    );
  }

  async connect() {
    if (this.state.connecting || this.state.connected) return;
    const problem = bluetoothProblem();
    if (problem) { this.#update({ error: problem, connecting: false, connectionStage: 'idle' }); return; }
    const attempt = ++this.#connectionAttempt;
    const controller = new AbortController();
    this.#connectionAbort = controller;
    let selected, stage = this.#device ? 'connecting' : 'selecting', operationName = 'requestDevice';
    const properties = {}, info = {}, warnings = [], polling = new Set(), subscribedNames = new Set();
    this.#unreadable.clear();
    let timeout = setTimeout(() => controller.abort(new DOMException('Device chooser timed out', 'TimeoutError')), 45000);
    const step = (operation, nextStage = stage, label = nextStage, discard) => {
      stage = nextStage;
      operationName = label;
      if (controller.signal.aborted || attempt !== this.#connectionAttempt) return Promise.reject(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      this.#update({ connectionStage: stage });
      return new Promise((resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
        // Invoke synchronously: requestDevice must keep the click's user activation.
        try {
          Promise.resolve(operation()).then(value => {
            controller.signal.removeEventListener('abort', abort);
            if (controller.signal.aborted || attempt !== this.#connectionAttempt) { discard?.(value); reject(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError')); }
            else resolve(value);
          }, error => { controller.signal.removeEventListener('abort', abort); reject(error); });
        } catch (error) { controller.signal.removeEventListener('abort', abort); reject(error); }
      });
    };
    this.#update({ connecting: true, connectionStage: stage, error: null, connectionDetail: null, connectionWarnings: [] });
    try {
      selected = this.#device ?? await step(() => navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "RNP-" }],
        optionalServices: [SERVICE.control, SERVICE.deviceInfo],
      }), 'selecting', 'requestDevice');
      this.#device = selected;
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(new DOMException('GATT initialization timed out', 'TimeoutError')), 20000);
      this.#device.removeEventListener("gattserverdisconnected", this.#onDisconnect);
      this.#device.addEventListener("gattserverdisconnected", this.#onDisconnect);

      const server = await step(() => selected.gatt.connect(), 'connecting', 'GATT.connect', late => { if (attempt === this.#connectionAttempt || this.#device !== selected) late.disconnect(); });
      const control = await step(() => server.getPrimaryService(SERVICE.control), 'connecting', 'control.getPrimaryService');
      const owner = await step(() => control.getCharacteristic(CHARACTERISTIC.owner), 'authenticating', 'owner.getCharacteristic');
      properties.owner = characteristicProperties(owner);
      const ownerFrame = Uint8Array.of(1, ...ownerKey());
      this.#log("write", "owner", ownerFrame);
      await step(() => writeCharacteristic(owner, ownerFrame), 'authenticating', 'owner.write');

      try {
        const infoService = await step(() => server.getPrimaryService(SERVICE.deviceInfo), 'reading', 'deviceInfo.getPrimaryService');
        for (const name of ['model', 'firmware']) {
          try {
            const characteristic = await step(() => infoService.getCharacteristic(DEVICE_INFO[name]), 'reading', `${name}.getCharacteristic`);
            properties[name] = characteristicProperties(characteristic);
            if (!readable(characteristic)) throw new DOMException('Characteristic is not readable', 'NotSupportedError');
            const value = await step(() => characteristic.readValue(), 'reading', `${name}.read`);
            info[name] = new TextDecoder().decode(value).replaceAll('\0', '');
          } catch (error) { if (!optionalUnsupported(error)) throw error; warnings.push(`${name}: ${error.name}`); }
        }
      } catch (error) { if (!optionalUnsupported(error)) throw error; warnings.push(`deviceInfo: ${error.name}`); }
      const deviceInfo = { name: selected.name, model: info.model??selected.name, firmware: info.firmware??'—' };
      const capability = await step(() => control.getCharacteristic(CHARACTERISTIC.capability), 'reading', 'capability.getCharacteristic');
      properties.capability = characteristicProperties(capability);
      const capabilityValue = await step(() => capability.readValue(), 'reading', 'capability.read');
      const capabilities = parseCapabilities(capabilityValue);

      const characteristicNames = ["mode", "battery", "temperature"];
      characteristicNames.push("authentication");
      if (capabilities.autoStart) {
        characteristicNames.push("autoStart");
      }
      if (capabilities.quickLaunch) {
        characteristicNames.push("quickLaunch");
      }
      for (const name of characteristicNames) {
        try {
          const characteristic = await step(() => control.getCharacteristic(CHARACTERISTIC[name]), 'reading', `${name}.getCharacteristic`);
          properties[name] = characteristicProperties(characteristic);
          this.#characteristics[name] = characteristic;
          if (name === 'mode' && !writable(characteristic)) throw new DOMException('Mode characteristic is not writable', 'NotSupportedError');
        } catch (error) { if (name === 'mode' || !optionalUnsupported(error)) throw error; warnings.push(`${name}: ${error.name}`); }
      }
      capabilities.autoStart = capabilities.autoStart && writable(this.#characteristics.autoStart);
      capabilities.quickLaunch = capabilities.quickLaunch && writable(this.#characteristics.quickLaunch);
      capabilities.tagLink = writable(this.#characteristics.authentication);

      for (const name of ['mode', 'battery', 'temperature'].filter(name=>this.#characteristics[name])) {
        let subscribed = false;
        try { subscribed = await step(() => this.#subscribe(name), 'reading', `${name}.startNotifications`); }
        catch (error) { if (!optionalUnsupported(error)) throw error; warnings.push(`${name}.startNotifications: ${error.name}`); }
        if (!subscribed && readable(this.#characteristics[name])) polling.add(name);
        if (subscribed) subscribedNames.add(name);
        if (name === 'mode' && !subscribed && !readable(this.#characteristics[name])) throw new DOMException('Mode has no supported state read or notification procedure', 'NotSupportedError');
      }
      const values = [];
      for (const name of ['mode', 'battery', 'temperature', 'autoStart', 'quickLaunch'].filter(name => readable(this.#characteristics[name]))) {
        try { values.push([name, await step(() => this.#read(name), 'reading', `${name}.read`)]); }
        catch (error) {
          if (!optionalUnsupported(error) || (name === 'mode' && !subscribedNames.has(name))) throw error;
          this.#unreadable.add(name); polling.delete(name); warnings.push(`${name}.read: ${error.name}`);
        }
      }
      this.#applyValues(values);
      this.#update({
        connected: true,
        connecting: false,
        connectionStage: 'idle',
        device: deviceInfo,
        capabilities,
        connectionWarnings: warnings,
        connectionDetail: { device: selected.name, model: info.model??null, firmware: info.firmware??null, properties, polling: [...polling], warnings },
      });
      this.#stopPolling();
      if (polling.size) this.#pollTimer = window.setInterval(() => {
        if (!this.state.connected || this.#refreshing) return;
        this.refresh([...polling]).catch(error => { this.#log('error', 'poll', new TextEncoder().encode(error.message)); });
      }, 5000);
    } catch (error) {
      if (attempt !== this.#connectionAttempt) return;
      selected?.gatt?.disconnect();
      this.#device = undefined;
      this.#characteristics = {};
      this.#update({
        connected: false,
        connecting: false,
        connectionStage: 'idle',
        error: connectionError(error, stage, operationName),
        connectionDetail: { stage, operation: operationName, error: error.name, message: error.message, device: selected?.name??null, model: info.model??null, firmware: info.firmware??null, properties, warnings },
      });
      this.#log("error", error.name, new TextEncoder().encode(error.message));
    } finally {
      clearTimeout(timeout);
      if (attempt === this.#connectionAttempt) this.#connectionAbort = null;
    }
  }

  cancelConnection() {
    this.#connectionAbort?.abort(new DOMException('Cancelled', 'AbortError'));
    this.#update({ connecting: false, connectionStage: 'idle', error: null });
  }

  disconnect() {
    this.#stopPolling();
    this.cancelConnection();
    this.#generation++;
    this.#device?.gatt?.disconnect();
  }

  async refresh(requestedNames = [
      "mode",
      "battery",
      "temperature",
      "autoStart",
      "quickLaunch",
    ]) {
    if (this.#refreshing) return;
    this.#refreshing = true;
    const generation = this.#generation;
    const run = this.#writeQueue.then(async () => {
      if (generation !== this.#generation || !this.state.connected) return;
      const values = [];
      for (const name of requestedNames.filter(name => this.#canRead(name))) {
        if (generation !== this.#generation) return;
        values.push([name, await this.#read(name)]);
      }
      if (generation === this.#generation) this.#applyValues(values);
    });
    this.#writeQueue = run.catch(()=>{});
    try { await run; } finally { this.#refreshing = false; }
  }

  writeMode(frame, guard) {
    return this.#write("mode", frame, true, guard);
  }

  writeAutomation(name, frame) {
    return this.#write(name, frame);
  }

  async linkTag() {
    this.#update({ pairingTag: true, error: null });
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE.tag] }],
        optionalManufacturerData: [SONY_COMPANY_ID],
      });
      const tag = await receiveTagAdvertisement(device);
      const written = await this.#write(
        "authentication",
        tagRegistrationFrame(tag.address),
        false,
      );
      if (!written) return;
      localStorage.setItem(TAG_ADDRESS_STORAGE, tag.address);
      this.#update({ tagLinked: true });
    } catch (error) {
      this.#update({
        error:
          error.name === "NotFoundError"
            ? "No Tag selected."
            : "Could not read the Tag. Press its button, keep it nearby, and try again.",
      });
      this.#log("error", error.name, new TextEncoder().encode(error.message));
    } finally {
      this.#update({ pairingTag: false });
    }
  }

  async unlinkTag() {
    const written = await this.#write(
      "authentication",
      tagUnregistrationFrame(),
      false,
    );
    if (!written) return;
    localStorage.removeItem(TAG_ADDRESS_STORAGE);
    this.#update({ tag: null, tagLinked: false });
  }

  async #readDeviceInfo(server) {
    const service = await server.getPrimaryService(SERVICE.deviceInfo);
    const model = await readText(service, DEVICE_INFO.model);
    const firmware = await readText(service, DEVICE_INFO.firmware);
    return { name: this.#device.name, model, firmware };
  }

  async #readCharacteristic(service, name) {
    const characteristic = await service.getCharacteristic(CHARACTERISTIC[name]);
    const value = await characteristic.readValue();
    this.#log("read", name, value);
    return value;
  }

  async #read(name) {
    const value = await this.#characteristics[name].readValue();
    this.#log("read", name, value);
    return value;
  }

  async #subscribe(name) {
    const characteristic = this.#characteristics[name];
    if (!characteristic.properties.notify && !characteristic.properties.indicate) {
      return false;
    }
    characteristic.addEventListener("characteristicvaluechanged", (event) => {
      this.#log("notify", name, event.target.value);
      this.#applyValues([[name, event.target.value]]);
    });
    await characteristic.startNotifications();
    return true;
  }

  #applyValues(values) {
    const patch = {};
    for (const [name, value] of values) {
      if (name === "mode") patch.mode = parseMode(value);
      if (name === "battery") patch.battery = parseBattery(value);
      if (name === "temperature") {
        const sensor = parseTemperature(value);
        if (sensor?.source === "tag") {
          patch.tag = sensor;
          patch.tagLinked = true;
        } else if (sensor) {
          patch.temperature = sensor;
        }
      }
      if (name === "autoStart") patch.autoStart = parseAutomation(value);
      if (name === "quickLaunch") patch.quickLaunch = parseAutomation(value);
    }
    this.#update(patch);
  }

  #write(name, frame, readBack = true, guard) {
    const generation = this.#generation;
    this.#writeQueue = this.#writeQueue
      .then(async () => {
        if (guard && !guard()) return null;
        if (generation !== this.#generation || !this.#characteristics[name]) return false;
        this.#log("write", name, frame);
        await writeCharacteristic(this.#characteristics[name], frame);
        if (readBack && this.#canRead(name)) {
          this.#applyValues([[name, await this.#read(name)]]);
        }
        return true;
      })
      .catch((error) => {
        this.#update({
          error: "The device rejected that change. Reconnect and try again.",
        });
        this.#log("error", error.name, new TextEncoder().encode(error.message));
        return false;
      });
    return this.#writeQueue;
  }
}

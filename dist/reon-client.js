import {
  CHARACTERISTIC,
  DEVICE_INFO,
  SERVICE,
  parseAutomation,
  automationFrame,
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

import {RETRY_DELAYS, bluetoothDelay, bluetoothStep, bluetoothTimeout, chooseBluetoothDevice, selectBluetoothDevice, transientBluetoothError} from './bluetooth-retry.js';

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

export function sameBluetoothDevice(a, b) {
  return !!a && !!b && (a === b || (!!a.id && a.id === b.id));
}

export class ReonClient {
  #device;
  #slot;
  #tagStorage;
  #isTaken;
  #characteristics = {};
  #listeners = new Set();
  #writeQueue = Promise.resolve();
  #generation = 0;
  #connectionAbort = null;
  #handshakeAbort = null;
  #linkAbort = null;
  #notifications = [];
  #pollTimer = null;
  #refreshing = false;
  #unreadable = new Set();
  #manualControlReady = false;
  #lastModeCommand = null;
  #canRead(name) { return readable(this.#characteristics[name]) && !this.#unreadable.has(name); }
  #stopPolling() { if (this.#pollTimer !== null) window.clearInterval(this.#pollTimer); this.#pollTimer = null; }
  #clearLink() {
    this.#stopPolling();
    this.#linkAbort?.abort();
    this.#linkAbort = null;
    this.#generation++;
    this.#writeQueue = Promise.resolve();
    this.#refreshing = false;
    this.#manualControlReady = false;
    this.#lastModeCommand = null;
    for (const [characteristic, listener] of this.#notifications) {
      characteristic.removeEventListener?.('characteristicvaluechanged',listener);
    }
    this.#notifications = [];
    this.#characteristics = {};
    this.#unreadable.clear();
  }

  #dropLink(device) {
    device?.removeEventListener('gattserverdisconnected',this.#onDisconnect);
    if (device && !this.#isTaken?.(device)) device.gatt.disconnect();
    this.#clearLink();
  }

  #recover() {
    if (!this.state.connected) return;
    this.#dropLink(this.#device);
    this.#update({connected:false, mode:null, tag:null});
    void this.connect({automatic:true});
  }

  #onDisconnect = event => {
    if (event.target !== this.#device || event.target.gatt.connected) return;
    if (this.#handshakeAbort) {
      this.#handshakeAbort.abort(new DOMException('Connection lost','NetworkError'));
      return;
    }
    this.#recover();
  };

  state = {
    connected: false,
    connecting: false,
    connectionStage: 'idle',
    reconnecting: false,
    recovered: false,
    device: null,
    capabilities: null,
    mode: null,
    battery: null,
    temperature: null,
    tag: null,
    autoStart: null,
    quickLaunch: null,
    tagLinked: false,
    pairingTag: false,
    error: null,
    connectionDetail: null,
    connectionWarnings: [],
    manualControl: null,
    lastStop: null,
  };

  // slot: identifies this unit when several REON devices are controlled at once.
  // isTaken(device): true when another controller already uses the selected device.
  constructor({ slot = 'a', isTaken = null } = {}) {
    this.#slot = slot;
    this.#isTaken = isTaken;
    this.#tagStorage = slot === 'a' ? TAG_ADDRESS_STORAGE : `${TAG_ADDRESS_STORAGE}-${slot}`;
    this.state = { ...this.state, slot, tagLinked: Boolean(localStorage.getItem(this.#tagStorage)) };
  }

  get slot() { return this.#slot; }
  get bluetoothDevice() { return this.#device ?? null; }

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
        detail: { slot: this.#slot, direction, name, hex: value ? toHex(value) : "" },
      }),
    );
  }

  async connect({automatic=false}={}) {
    if (this.#connectionAbort || this.state.connected || (automatic && !this.#device)) return;
    const problem = bluetoothProblem();
    if (problem) { this.#update({error:problem}); return; }
    const controller = new AbortController();
    const {signal} = controller;
    this.#connectionAbort = controller;
    let selected = this.#device;
    let stage = selected ? 'connecting' : 'selecting', operation = 'requestDevice';
    let diagnostics = {}, attempts = 0;
    this.#update({connecting:true, reconnecting:automatic, recovered:false, connectionStage:stage,
      error:null, connectionWarnings:[], manualControl:null, lastStop:null, mode:null,
      tag:null, battery:null, temperature:null, autoStart:null, quickLaunch:null});
    try {
      selected ??= await selectBluetoothDevice({
        filters: [{namePrefix:'RNP-'}],
        optionalServices: [SERVICE.control,SERVICE.deviceInfo],
      },signal);
      if (this.#isTaken?.(selected)) {
        if (this.#device === selected) this.#device = undefined;
        throw new DOMException('Device already connected in another slot','DuplicateDeviceError');
      }
      this.#device = selected;
      const delays = automatic ? RETRY_DELAYS : [0,...RETRY_DELAYS];
      for (const delay of delays) {
        if (delay) {
          this.#update({connectionStage:'retrying'});
          await bluetoothDelay(delay,signal);
        }
        attempts++;
        const handshake = new AbortController();
        this.#handshakeAbort = handshake;
        const timeout = bluetoothTimeout(AbortSignal.any([signal,handshake.signal]),20000);
        const deadline = timeout.signal;
        diagnostics = {properties:{}, info:{}, warnings:[], polling:new Set()};
        const step = (run, nextStage, label, discard) => {
          stage = nextStage;
          operation = label;
          if (this.state.connectionStage !== stage) this.#update({connectionStage:stage});
          return bluetoothStep(run,deadline,discard);
        };
        try {
          selected.addEventListener('gattserverdisconnected',this.#onDisconnect);
          const server = await step(() => selected.gatt.connect(),'connecting','GATT.connect',late => {
            if ((!this.#connectionAbort || this.#connectionAbort === controller) &&
                !this.state.connected && !this.#handshakeAbort && !this.#isTaken?.(selected)) late.disconnect();
          });
          const {deviceInfo,capabilities,values} = await this.#initializeConnection(selected,server,step,diagnostics);
          if (deadline.aborted) throw deadline.reason;
          this.#applyValues(values);
          if (deadline.aborted) throw deadline.reason;
          this.#handshakeAbort = null;
          this.#connectionAbort = null;
          this.#linkAbort = new AbortController();
          const {info,properties,polling,warnings} = diagnostics;
          this.#update({connected:true, connecting:false, reconnecting:false, recovered:automatic,
            connectionStage:'idle', device:deviceInfo, capabilities, connectionWarnings:warnings,
            connectionDetail:{device:selected.name, model:info.model??null, firmware:info.firmware??null,
              properties, polling:[...polling], warnings, attempts, automatic}});
          if (polling.size && this.state.connected) this.#pollTimer = window.setInterval(() => {
            if (!this.state.connected || this.#refreshing) return;
            this.refresh([...polling]).catch(error => { this.#log('error','poll',new TextEncoder().encode(error.message)); });
          },5000);
          return;
        } catch (error) {
          if (this.#connectionAbort !== controller) return;
          this.#handshakeAbort = null;
          this.#dropLink(selected);
          if (signal.aborted || attempts === delays.length || operation === 'owner.write' || !transientBluetoothError(error)) throw error;
        } finally { timeout.clear(); }
      }
    } catch (error) {
      if (this.#connectionAbort !== controller) return;
      this.#device = undefined;
      const {info,properties,warnings} = diagnostics;
      this.#update({connected:false, connecting:false, reconnecting:false, connectionStage:'idle',
        error:connectionError(error,stage,operation),
        connectionDetail:{stage, operation, error:error.name, message:error.message, device:selected?.name??null,
          model:info?.model??null, firmware:info?.firmware??null, properties, warnings, attempts, automatic}});
      this.#log('error',error.name,new TextEncoder().encode(error.message));
    } finally {
      if (this.#connectionAbort === controller) this.#connectionAbort = null;
    }
  }

  async #initializeConnection(selected, server, step, {properties,info,warnings,polling}) {
    const subscribedNames = new Set();
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
    return {deviceInfo,capabilities,values};
  }

  cancelConnection() {
    if (!this.#connectionAbort) return;
    this.#connectionAbort.abort();
    this.#connectionAbort = this.#handshakeAbort = null;
    this.#dropLink(this.#device);
    this.#update({connecting:false, reconnecting:false, connectionStage:'idle', error:null});
  }

  disconnect() {
    if (this.#connectionAbort) { this.cancelConnection(); return; }
    if (!this.state.connected) return;
    this.#dropLink(this.#device);
    this.#update({connected:false, reconnecting:false, mode:null, tag:null});
  }

  #linkStep(run, generation) {
    const signal = this.#linkAbort?.signal;
    if (generation !== this.#generation || !signal) throw new DOMException('Connection lost','AbortError');
    const timeout = bluetoothTimeout(signal,8000);
    return bluetoothStep(run,timeout.signal).catch(error => {
      if (generation === this.#generation && (error.name === 'TimeoutError' ||
          (error.name === 'NetworkError' && !this.#device?.gatt.connected))) this.#recover();
      throw error;
    }).finally(timeout.clear);
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
        values.push([name, await this.#linkStep(() => this.#read(name),generation)]);
      }
      if (generation === this.#generation) this.#applyValues(values);
    });
    this.#writeQueue = run.catch(()=>{});
    try { await run; } finally { if (generation === this.#generation) this.#refreshing = false; }
  }

  writeMode(frame, guard) {
    return this.#write("mode", frame, true, guard);
  }

  writeAutomation(name, frame) {
    if (name === 'autoStart') this.#manualControlReady = false;
    return this.#write(name, frame);
  }

  async #prepareManualControl(generation) {
    if (this.#manualControlReady && this.state.autoStart !== true) return;
    const characteristic = this.#characteristics.autoStart;
    if (!characteristic) return;
    const before = this.state.autoStart;
    const fail = message => Object.assign(new Error('AUTO START/STOPを無効にできないため、運転を開始しませんでした。'+message),{name:'ManualControlError'});
    if (!writable(characteristic)) {
      if (before === false) { this.#manualControlReady = true; return; }
      throw fail('本体の設定を確認してください。');
    }
    // This is the wear-detection setting, not a thermal protection override.
    this.#log('write','autoStart',automationFrame(false));
    try { await this.#linkStep(() => writeCharacteristic(characteristic,automationFrame(false)),generation); }
    catch (error) { throw fail(error.message); }
    if (generation !== this.#generation) return;
    let verified = false;
    if (this.#canRead('autoStart')) {
      try {
        const value = await this.#linkStep(() => this.#read('autoStart'),generation);
        if (value.byteLength < 1 || parseAutomation(value)) throw fail('無効化後も本体がONを報告しています。');
        verified = true;
      } catch (error) {
        if (!optionalUnsupported(error)) throw error.name==='ManualControlError'?error:fail(error.message);
        this.#unreadable.add('autoStart');
      }
    }
    if (generation !== this.#generation) return;
    this.#manualControlReady = true;
    const manualControl = {autoStartBefore:before,autoStartDisabled:true,readBackVerified:verified,updatedAt:new Date().toISOString()};
    this.#update({autoStart:verified?false:null,manualControl,connectionDetail:{...this.state.connectionDetail,manualControl}});
  }

  async linkTag() {
    const generation = this.#generation;
    this.#update({ pairingTag: true, error: null });
    try {
      const device = await chooseBluetoothDevice({
        filters: [{ services: [SERVICE.tag] }],
        optionalManufacturerData: [SONY_COMPANY_ID],
      });
      const tag = await receiveTagAdvertisement(device);
      if (generation !== this.#generation || !this.state.connected) return;
      const written = await this.#write(
        "authentication",
        tagRegistrationFrame(tag.address),
        false,
      );
      if (!written) return;
      localStorage.setItem(this.#tagStorage, tag.address);
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
    localStorage.removeItem(this.#tagStorage);
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
    const generation = this.#generation;
    const listener = event => {
      if (generation !== this.#generation) return;
      this.#log("notify", name, event.target.value);
      this.#applyValues([[name, event.target.value]]);
    };
    this.#notifications.push([characteristic,listener]);
    characteristic.addEventListener("characteristicvaluechanged",listener);
    await characteristic.startNotifications();
    return true;
  }

  #applyValues(values) {
    const patch = {};
    for (const [name, value] of values) {
      if (name === "mode") {
        patch.mode = parseMode(value);
        if (this.state.connected && this.state.mode?.running && patch.mode && !patch.mode.running) {
          patch.lastStop = {time:new Date().toISOString(),source:this.#lastModeCommand?.running===false?'app_command':'device_report',autoStart:this.state.autoStart,manualControl:this.state.manualControl};
          patch.connectionDetail = {...this.state.connectionDetail,lastStop:patch.lastStop};
        }
      }
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
        const requestedMode = name==='mode'?parseMode(frame):null;
        if (requestedMode?.type==='manual' && requestedMode.running) await this.#prepareManualControl(generation);
        if (guard && !guard()) return null;
        if (generation !== this.#generation || !this.#characteristics[name]) return false;
        if (this.state.error) this.#update({error:null});
        if (requestedMode) this.#lastModeCommand = requestedMode;
        this.#log("write", name, frame);
        await this.#linkStep(() => writeCharacteristic(this.#characteristics[name],frame),generation);
        if (generation !== this.#generation) return false;
        if (readBack && this.#canRead(name)) {
          const value = await this.#linkStep(() => this.#read(name),generation);
          if (generation === this.#generation) this.#applyValues([[name,value]]);
        }
        return true;
      })
      .catch((error) => {
        if (generation !== this.#generation) return false;
        this.#update({
          error: error.name==='ManualControlError'?error.message:"The device rejected that change. Reconnect and try again.",
        });
        this.#log("error", error.name, new TextEncoder().encode(error.message));
        return false;
      });
    return this.#writeQueue;
  }
}

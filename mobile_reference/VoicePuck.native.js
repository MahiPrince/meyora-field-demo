import { BleManager, State as BleState } from 'react-native-ble-plx';
import { encode as base64Encode, decode as base64Decode } from 'base-64';

// CMD Sally VoicePuck V4.2A GATT contract.
export const VOICEPUCK_SERVICE_UUID = '7f3a1000-5f4d-4f2f-a921-1c71b9d44210';
export const VOICEPUCK_STATE_UUID   = '7f3a1001-5f4d-4f2f-a921-1c71b9d44210';
export const VOICEPUCK_COMMAND_UUID = '7f3a1002-5f4d-4f2f-a921-1c71b9d44210';

const EMPTY_STATE = {
  supported: true,
  ble_state: 'unknown',
  connected: false,
  reconnecting: false,
  scanning: false,
  device_id: null,
  device_name: null,
  transport_device_id: null,
  state: 'idle',
  battery_percent: null,
  storage_free_mb: null,
  firmware_version: null,
  wifi_connected: false,
  wifi_ssid: null,
  wifi_validation: 'idle',
  active_session_id: null,
  last_session_id: null,
  recording_duration_ms: 0,
  pending_sessions: [],
  pending_count: 0,
  sync: null,
  error: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeUtf8(value) {
  return base64Encode(unescape(encodeURIComponent(String(value))));
}

function decodeUtf8(value) {
  if (!value) return '';
  return decodeURIComponent(escape(base64Decode(value)));
}

function normalizedDevice(device) {
  return {
    id: device?.id,
    name: device?.name || device?.localName || 'CMD Sally VoicePuck',
    rssi: device?.rssi ?? null,
  };
}

class VoicePuckClient {
  constructor() {
    this.listeners = new Set();
    this.devices = new Map();
    this.device = null;
    this.monitorSubscription = null;
    this.disconnectSubscription = null;
    this.scanTimer = null;
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.preferredDeviceId = null;
    this.manualDisconnect = false;
    this.autoScanActive = false;
    this.state = { ...EMPTY_STATE };

    this.manager = new BleManager({
      restoreStateIdentifier: 'cmd-sally-voicepuck-v42',
      restoreStateFunction: (restored) => {
        const device = restored?.connectedPeripherals?.[0];
        if (device?.id) {
          this.preferredDeviceId = device.id;
          this.manualDisconnect = false;
          this.connect(device.id, { automatic: true }).catch(() => {
            this._scheduleReconnect(1200);
          });
        }
      },
    });

    this.manager.onStateChange((state) => {
      const bleState = String(state || 'unknown').toLowerCase();
      const poweredOn = state === BleState.PoweredOn;

      this._patch({
        ble_state: bleState,
        ...(poweredOn ? {} : { connected: false, reconnecting: false }),
      });

      if (poweredOn && !this.manualDisconnect) {
        this._scheduleReconnect(250);
      }
    }, true);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener({ ...this.state, devices: [...this.devices.values()] });

    // Subscribing means the Sally UI is alive. Make a best effort to find the
    // remembered/nearby Puck without requiring the user to tap Connect again.
    if (!this.manualDisconnect) this._scheduleReconnect(200);

    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return { ...this.state, devices: [...this.devices.values()] };
  }

  _emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch {}
    }
  }

  _patch(patch) {
    this.state = { ...this.state, ...patch };
    this._emit();
  }

  _applyPeripheralState(payload) {
    if (!payload || typeof payload !== 'object') return;

    const pendingRaw = payload.pending_sessions ?? payload.pending ?? payload.p;
    const pending = Array.isArray(pendingRaw)
      ? pendingRaw.filter(Boolean).map(String)
      : (typeof pendingRaw === 'string'
          ? (pendingRaw ? [pendingRaw] : [])
          : this.state.pending_sessions);

    const battery = payload.battery_percent ?? payload.bat ?? payload.b;
    const storage = payload.storage_free_mb ?? payload.free ?? payload.f;
    const pendingCountRaw = payload.pending_count ?? payload.q;

    const peripheralState =
      payload.state || payload.st || payload.s || this.state.state || 'idle';

    this._patch({
      connected: true,
      reconnecting: false,
      device_id:
        payload.device_id ||
        payload.did ||
        payload.d ||
        this.state.device_id ||
        this.device?.id ||
        null,
      state: peripheralState,
      battery_percent:
        battery == null ? this.state.battery_percent :
        (Number.isFinite(Number(battery)) ? Number(battery) : null),
      storage_free_mb:
        storage == null ? this.state.storage_free_mb :
        (Number.isFinite(Number(storage)) ? Number(storage) : null),
      firmware_version:
        payload.firmware_version ||
        payload.fw ||
        payload.v ||
        this.state.firmware_version ||
        null,
      wifi_connected: Boolean(payload.wifi_connected ?? payload.wifi ?? payload.w),
      wifi_ssid: payload.wifi_ssid || payload.ssid || this.state.wifi_ssid || null,
      wifi_validation:
        payload.wifi_validation ||
        payload.wifi_check ||
        payload.x ||
        this.state.wifi_validation ||
        'idle',
      active_session_id:
        payload.active_session_id ||
        payload.act ||
        payload.a ||
        (peripheralState === 'recording' ? this.state.active_session_id : null),
      last_session_id:
        payload.last_session_id ||
        payload.last ||
        payload.l ||
        this.state.last_session_id ||
        null,
      recording_duration_ms: Number(
        payload.recording_duration_ms ?? payload.dur ?? payload.t ?? 0
      ),
      pending_sessions: pending,
      pending_count: pendingCountRaw == null
        ? (Array.isArray(pending) ? Math.max(this.state.pending_count || 0, pending.length) : this.state.pending_count)
        : (Number.isFinite(Number(pendingCountRaw)) ? Number(pendingCountRaw) : this.state.pending_count),
      sync: payload.sync || this.state.sync || null,
      error: payload.error || payload.err || payload.e || null,
    });
  }

  async ensurePoweredOn() {
    const state = await this.manager.state();
    this._patch({ ble_state: String(state || 'unknown').toLowerCase() });
    if (state !== BleState.PoweredOn) {
      throw new Error('Bluetooth is not powered on. Turn on Bluetooth and try again.');
    }
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _scheduleReconnect(delayMs = 1200) {
    if (
      this.manualDisconnect ||
      this.state.connected ||
      this.connectPromise ||
      this.reconnectTimer
    ) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._autoReconnect().catch(() => {
        this._scheduleReconnect(2500);
      });
    }, delayMs);
  }

  async _autoReconnect() {
    if (this.manualDisconnect || this.state.connected || this.connectPromise) return;

    await this.ensurePoweredOn();
    this._patch({ reconnecting: true, error: null });

    // First ask iOS for an already-connected/restored peripheral.
    try {
      const connected = await this.manager.connectedDevices([VOICEPUCK_SERVICE_UUID]);
      const target =
        connected.find((item) => item?.id === this.preferredDeviceId) ||
        connected[0];

      if (target?.id) {
        await this.connect(target.id, { automatic: true });
        return;
      }
    } catch {}

    // If it is not currently connected, briefly scan for the known service.
    // On a fresh app launch there may be no remembered id yet, so the first
    // nearby VoicePuck becomes the preferred device.
    if (this.autoScanActive) return;
    this.autoScanActive = true;

    try {
      const foundId = await new Promise((resolve) => {
        let finished = false;

        const finish = (id = null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { this.manager.stopDeviceScan(); } catch {}
          resolve(id);
        };

        const timer = setTimeout(() => finish(null), 2600);

        this.manager.startDeviceScan(
          [VOICEPUCK_SERVICE_UUID],
          { allowDuplicates: false },
          (error, device) => {
            if (error) return finish(null);
            if (!device?.id) return;

            this.devices.set(device.id, normalizedDevice(device));
            this._emit();

            if (this.preferredDeviceId && device.id !== this.preferredDeviceId) {
              return;
            }

            finish(device.id);
          }
        );
      });

      if (foundId && !this.manualDisconnect) {
        await this.connect(foundId, { automatic: true });
        return;
      }
    } finally {
      this.autoScanActive = false;
    }

    this._patch({ reconnecting: false });
    this._scheduleReconnect(2500);
  }

  async scan(timeoutMs = 6500) {
    await this.ensurePoweredOn();
    if (this.state.scanning) return [...this.devices.values()];

    this._clearReconnectTimer();
    this.devices.clear();
    this._patch({ scanning: true, error: null, reconnecting: false });

    await new Promise((resolve, reject) => {
      let finished = false;

      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
        try { this.manager.stopDeviceScan(); } catch {}
        this._patch({ scanning: false });
        error ? reject(error) : resolve();
      };

      this.manager.startDeviceScan(
        [VOICEPUCK_SERVICE_UUID],
        { allowDuplicates: false },
        (error, device) => {
          if (error) return finish(error);
          if (!device?.id) return;
          this.devices.set(device.id, normalizedDevice(device));
          this._emit();
        }
      );

      this.scanTimer = setTimeout(() => finish(null), timeoutMs);
    });

    if (!this.state.connected && !this.manualDisconnect) {
      this._scheduleReconnect(1200);
    }

    return [...this.devices.values()];
  }

  async connect(deviceId, { automatic = false } = {}) {
    if (!deviceId) throw new Error('VoicePuck device id is required.');

    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      await this.ensurePoweredOn();

      this.manualDisconnect = false;
      this.preferredDeviceId = deviceId;
      this._clearReconnectTimer();

      try { this.manager.stopDeviceScan(); } catch {}

      this._patch({
        reconnecting: automatic,
        scanning: false,
        error: null,
      });

      // Reuse the existing device object only when it is genuinely connected.
      let raw = null;
      try {
        if (this.device?.id === deviceId) {
          const stillConnected = await this.device.isConnected();
          if (stillConnected) raw = this.device;
        }
      } catch {}

      if (!raw) {
        raw = await this.manager.connectToDevice(deviceId, { timeout: 12000 });
      }

      const device = await raw.discoverAllServicesAndCharacteristics();
      this.device = device;

      this.monitorSubscription?.remove?.();
      this.monitorSubscription = device.monitorCharacteristicForService(
        VOICEPUCK_SERVICE_UUID,
        VOICEPUCK_STATE_UUID,
        (error, characteristic) => {
          if (error) {
            // A transient monitor error often accompanies a disconnect. The
            // disconnect callback below owns reconnection.
            if (this.state.connected) {
              this._patch({ error: error.message || String(error) });
            }
            return;
          }

          try {
            const decoded = decodeUtf8(characteristic?.value || '');
            if (decoded) this._applyPeripheralState(JSON.parse(decoded));
          } catch (decodeError) {
            this._patch({
              error: `VoicePuck state decode failed: ${
                decodeError?.message || decodeError
              }`,
            });
          }
        }
      );

      this.disconnectSubscription?.remove?.();
      this.disconnectSubscription = this.manager.onDeviceDisconnected(
        device.id,
        (error) => {
          if (this.device?.id !== device.id) return;

          this.monitorSubscription?.remove?.();
          this.monitorSubscription = null;
          this.device = null;

          // Preserve the last known peripheral state. If the Puck was recording,
          // it keeps recording offline and Sally should not falsely change it to idle.
          this._patch({
            connected: false,
            reconnecting: !this.manualDisconnect,
            error: this.manualDisconnect ? null : (error?.message || null),
          });

          if (!this.manualDisconnect) {
            this._scheduleReconnect(700);
          }
        }
      );

      this._patch({
        connected: true,
        reconnecting: false,
        // device.id is iOS/CoreBluetooth's transport UUID, NOT the stable
        // VoicePuck hardware id used by the backend sync-ticket contract.
        transport_device_id: device.id,
        device_id:
          this.state.transport_device_id === device.id &&
          typeof this.state.device_id === 'string' &&
          this.state.device_id.startsWith('VP-')
            ? this.state.device_id
            : null,
        device_name: device.name || device.localName || 'CMD Sally VoicePuck',
        scanning: false,
        error: null,
      });

      await this.sendCommand({ op: 'status' });
      return this.snapshot();
    })();

    try {
      return await this.connectPromise;
    } catch (error) {
      this._patch({
        connected: false,
        reconnecting: !this.manualDisconnect,
        error: automatic ? null : (error?.message || String(error)),
      });
      if (!this.manualDisconnect) this._scheduleReconnect(1800);
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();

    const id = this.device?.id || this.state.device_id;

    this.monitorSubscription?.remove?.();
    this.monitorSubscription = null;

    this.disconnectSubscription?.remove?.();
    this.disconnectSubscription = null;

    if (id) {
      try { await this.manager.cancelDeviceConnection(id); } catch {}
    }

    this.device = null;
    this.state = {
      ...EMPTY_STATE,
      ble_state: this.state.ble_state,
      supported: true,
    };
    this._emit();
  }

  async sendCommand(payload) {
    if (!this.device) throw new Error('Connect a VoicePuck first.');

    const json = JSON.stringify(payload);

    // Keep commands below a conservative BLE payload size.
    // Long audio never travels over BLE.
    if (unescape(encodeURIComponent(json)).length > 180) {
      throw new Error(
        'VoicePuck command is too large for the V4.2A BLE control channel.'
      );
    }

    await this.device.writeCharacteristicWithResponseForService(
      VOICEPUCK_SERVICE_UUID,
      VOICEPUCK_COMMAND_UUID,
      encodeUtf8(json)
    );
  }

  async requestStatus() {
    await this.sendCommand({ op: 'status' });
  }

  async provisionWifi(ssid, password, timeoutMs = 15000) {
    const cleanSsid = ssid?.trim();
    if (!cleanSsid) throw new Error('Wi-Fi SSID is required.');

    this._patch({ wifi_validation: 'checking', error: null });

    await this.sendCommand({
      op: 'wifi',
      ssid: cleanSsid,
      pw: String(password || ''),
    });

    // A BLE write only proves the credentials reached the Puck. FINAL-09 waits
    // for the Puck to actually associate before reporting success.
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(450);
      try { await this.requestStatus(); } catch {}
      await sleep(180);

      const result = String(this.state.wifi_validation || 'idle');

      if (result === 'ok' && this.state.wifi_connected) {
        return true;
      }

      if (result === 'no_ssid') {
        throw new Error(`Could not find Wi-Fi network “${cleanSsid}”. Check the SSID and signal.`);
      }

      if (result === 'auth_failed') {
        throw new Error('Wi-Fi connection failed. Check the password and try again.');
      }

      if (result === 'timeout') {
        throw new Error('VoicePuck could not join that Wi-Fi network within 12 seconds. Check the SSID/password and signal.');
      }
    }

    throw new Error('VoicePuck Wi-Fi check timed out. The new credentials were not saved.');
  }

  async startRecording() {
    await this.sendCommand({ op: 'start' });
  }

  async stopRecording() {
    await this.sendCommand({ op: 'stop' });
  }

  async syncSession(sessionId, ticketId, ticketSecret) {
    await this.sendCommand({
      op: 'sync',
      sid: sessionId,
      tid: ticketId,
      sec: ticketSecret,
    });
  }

  async acknowledgeSyncedSession(sessionId, serverAckId, timeoutMs = 5500) {
    await this.sendCommand({
      op: 'ack',
      sid: sessionId,
      ack: serverAckId,
    });

    // A BLE write only proves the command reached the characteristic. It does
    // NOT prove the Puck accepted the ACK or deleted the local Session.
    // Poll the Puck and require the Session to disappear from the pending queue.
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(350);

      try {
        await this.requestStatus();
      } catch {}

      await sleep(180);

      const pending = Array.isArray(this.state.pending_sessions)
        ? this.state.pending_sessions
        : [];

      if (!pending.includes(String(sessionId))) {
        return true;
      }
    }

    const error = new Error(
      'Server has the Session, but VoicePuck did not confirm safe local deletion. The recording is still protected on the Puck.'
    );
    error.code = 'voicepuck_delete_ack_not_confirmed';
    throw error;
  }

  async archiveLegacySession(sessionId, timeoutMs = 5500) {
    await this.sendCommand({ op: 'archive', sid: sessionId });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      try { await this.requestStatus(); } catch {}
      await sleep(150);

      const pending = Array.isArray(this.state.pending_sessions)
        ? this.state.pending_sessions
        : [];
      if (!pending.includes(String(sessionId))) return true;
    }

    throw new Error('VoicePuck could not archive the legacy local Session copy. No audio was deleted.');
  }

}

export default new VoicePuckClient();
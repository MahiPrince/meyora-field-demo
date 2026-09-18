import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Speech from 'expo-speech';
import * as Location from 'expo-location';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  createAudioPlayer,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import VoicePuck from './VoicePuck';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

WebBrowser.maybeCompleteAuthSession();

// ============================================================
// CMD SALLY — CONFIG
// ============================================================

const TENANT_ID = 'f16f1977-60f1-4477-b789-20b60fd70b84';
const MOBILE_CLIENT_ID = '152e8a61-4e12-4459-a43d-768587b74ee3';
const API_CLIENT_ID = '58d4b552-6ebd-48e1-bdfb-dc751af16a15';
const API_SCOPE = `api://${API_CLIENT_ID}/access_as_user`;
const API_URL = 'https://cloudaiapi01.onrender.com';

const SESSION_RECORDING_OPTIONS = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 64000,
  },
};

const EMPTY_VOICEPUCK = {
  assigned: false,
  connected: false,
  device_id: null,
  battery_percent: null,
  storage_free_mb: null,
  firmware_version: null,
};


const SALLY_SPEECH_CONTEXT = [
  'CMD Sally',
  'Salesforce',
  'opportunity',
  'pipeline',
  'Orbitrap',
  'Astral',
  'Excedion',
  'Exploris',
  'HRAM',
  'FAIMS',
  'Vanquish',
  'Chromeleon',
  'TSQ Altis',
  'Thermo Fisher Scientific',
];

const discovery = {
  authorizationEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
};

const redirectUri = AuthSession.makeRedirectUri({
  scheme: 'cmdai-dev',
  path: 'auth',
});

// ============================================================
// SMALL HELPERS
// ============================================================

function newId(prefix = 'm') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponse(response) {
  const raw = await response.text();
  let body = null;

  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const detail =
      body?.details ||
      body?.detail ||
      body?.message ||
      body?.error ||
      (typeof body?.raw === 'string' ? body.raw.slice(0, 800) : null) ||
      `HTTP ${response.status}`;

    const error = new Error(detail);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function getConfirmationToken(body) {
  return (
    body?.confirmation_token ||
    body?.confirm_token ||
    body?.confirmationToken ||
    body?.token ||
    null
  );
}

function getPendingChanges(body) {
  const changes =
    body?.pending_actions ||
    body?.pending_changes ||
    body?.changes ||
    body?.pending ||
    body?.proposed_changes ||
    [];

  return Array.isArray(changes) ? changes : [];
}

function humanizeFieldName(value) {
  const map = {
    StageName: 'Stage',
    CloseDate: 'Close date',
    NextStep: 'Next step',
    Amount: 'Amount',
    Probability: 'Probability',
    Primary_Product__c: 'Primary product',
    Confidence_Level__c: 'Confidence',
    Add_to_Forecast__c: 'Add to forecast',
    Comments__c: 'Comments',
    Description: 'Description',
    Status: 'Status',
    Priority: 'Priority',
    Subject: 'Subject',
    StartDateTime: 'Start time',
    EndDateTime: 'End time',
    ActivityDate: 'Date',
    IsAllDayEvent: 'All-day event',
    Location: 'Location',
    WhoId: 'Contact',
    WhatId: 'Related record',
  };
  return map[value] || value || 'Field';
}

function normaliseChange(change, index) {
  const action = change?.action || 'update_opportunity';

  if (action === 'create_event') {
    return {
      kind: 'create_event',
      recordName: change?.event_subject || change?.fields?.Subject || `Event ${index + 1}`,
      fields: change?.fields || {},
      who: change?.who || null,
      what: change?.what || null,
    };
  }

  if (action === 'create_opportunity') {
    return {
      kind: 'create_opportunity',
      recordName: change?.opportunity_name || change?.fields?.Name || `Opportunity ${index + 1}`,
      fields: change?.fields || {},
      account: change?.account || null,
      primaryContact: change?.primary_contact || null,
      contactRole: change?.contact_role || null,
    };
  }

  if (action === 'create_task') {
    return {
      kind: 'create_task',
      recordName: change?.task_subject || change?.fields?.Subject || `Task ${index + 1}`,
      fields: change?.fields || {},
      who: change?.who || null,
      what: change?.what || null,
    };
  }

  const recordName =
    change?.record_name ||
    change?.event_subject ||
    change?.opportunity_name ||
    change?.name ||
    change?.record_id ||
    `Change ${index + 1}`;

  const field = change?.field || change?.field_name || change?.Field || 'Field';
  const oldValue =
    change?.old_value ??
    change?.oldValue ??
    change?.before ??
    change?.current_value ??
    '—';
  const newValue =
    change?.new_value ??
    change?.newValue ??
    change?.after ??
    change?.value ??
    '—';

  const kind =
    action === 'update_event'
      ? 'update_event'
      : action === 'update_task'
        ? 'update_task'
        : 'update_opportunity';

  return {
    kind,
    recordName,
    field,
    oldValue,
    newValue,
  };
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (Math.abs(number) >= 1000000) return `$${(number / 1000000).toFixed(number % 1000000 ? 1 : 0)}M`;
  if (Math.abs(number) >= 1000) return `$${(number / 1000).toFixed(number % 1000 ? 1 : 0)}K`;
  return `$${number.toLocaleString()}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatAddress(address) {
  if (!address) return '—';
  return [address.street, address.city, address.state, address.postal_code, address.country]
    .filter(Boolean)
    .join(', ') || '—';
}

function dialPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return;
  const cleaned = raw.replace(/[^0-9+*#,;]/g, '');
  if (cleaned) Linking.openURL(`tel:${cleaned}`).catch(() => {});
}

function displayChangeValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'StartDateTime' || field === 'EndDateTime') return formatDateTime(String(value));
  if (field === 'ActivityDate' || field === 'CloseDate') return formatDate(String(value));
  if (field === 'Amount') return formatMoney(value);
  if (field === 'Probability') return `${value}%`;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}


function buildConversationHistory(messages) {
  return messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !message.localOnly &&
        typeof (message.historyText || message.text) === 'string' &&
        (message.historyText || message.text).trim()
    )
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: (message.historyText || message.text).trim(),
    }));
}

function getClientContext(location = null, geoSessionId = null) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  let timezone = null;

  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timezone = null;
  }

  const localDateTime =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  return {
    timezone,
    local_datetime: localDateTime,
    utc_offset_minutes: -now.getTimezoneOffset(),
    location: location || undefined,
    geo_session_id: geoSessionId || undefined,
  };
}


function prepareTextForSpeech(value) {
  let text = String(value || '');

  // Keep the useful words, remove formatting/noise that sounds bad in TTS.
  text = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, '')
    .replace(/[|]/g, ', ')
    .replace(/[*_#>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Don't read a giant CRM table aloud. The full answer remains on screen.
  if (text.length > 1400) {
    const slice = text.slice(0, 1320);
    const sentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! ')
    );
    text = `${slice.slice(0, sentenceEnd > 700 ? sentenceEnd + 1 : 1250).trim()} I've put the rest on screen.`;
  }

  return text;
}


function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '—';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

function sessionStatusLabel(status) {
  const labels = {
    uploaded: 'Uploaded',
    transcribing: 'Transcribing…',
    analyzing: 'Analyzing…',
    ready: 'Ready',
    error: 'Needs attention',
    upload_failed: 'Upload failed',
    recording: 'Recording',
    uploading: 'Uploading…',
  };
  return labels[status] || status || 'Unknown';
}

function locationDisplayLabel(location) {
  if (!location) return null;
  return [location.city, location.region, location.country].filter(Boolean).join(', ') || location.label || null;
}

// ============================================================
// APP
// ============================================================

export default function App() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const layoutMode = windowWidth >= 1100 ? 'wide' : windowWidth >= 680 ? 'tablet' : 'compact';
  const isCompact = layoutMode === 'compact';
  const isWide = layoutMode === 'wide';

  const [accessToken, setAccessToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('signed_out');
  const [authError, setAuthError] = useState(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState(null);
  const [runtimeSpeechContext, setRuntimeSpeechContext] = useState([]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [processingStatus, setProcessingStatus] = useState(null);
  const [processingEvents, setProcessingEvents] = useState([]);
  const [activeChatJobId, setActiveChatJobId] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [lastDebug, setLastDebug] = useState(null);

  // Native voice: on-device STT + local iPhone TTS.
  const [recognizing, setRecognizing] = useState(false);
  const [voiceDraftReady, setVoiceDraftReady] = useState(false);
  const [speechError, setSpeechError] = useState(null);
  const [speakingMessageId, setSpeakingMessageId] = useState(null);
  const [sallyVoice, setSallyVoice] = useState(null);
  const [sallyVoices, setSallyVoices] = useState([]);

  // Location + demo geography.
  const [deviceLocation, setDeviceLocation] = useState(null);
  const [locationContext, setLocationContext] = useState(null);
  const [locationStatus, setLocationStatus] = useState('idle');
  const [locationError, setLocationError] = useState(null);

  // Session workspace.
  const [activeTab, setActiveTab] = useState('chat');
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionTranscript, setSessionTranscript] = useState(null);
  const [sessionLinkOptions, setSessionLinkOptions] = useState([]);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [localSession, setLocalSession] = useState(null);
  const [sessionSource, setSessionSource] = useState('iphone');
  const [voicePuckScanState, setVoicePuckScanState] = useState('idle');
  const [voicePuckState, setVoicePuckState] = useState(() => VoicePuck.snapshot());
  const [voicePuckDevices, setVoicePuckDevices] = useState([]);
  const [voicePuckBusy, setVoicePuckBusy] = useState(false);
  const [voicePuckError, setVoicePuckError] = useState(null);
  const [voicePuckWifiSsid, setVoicePuckWifiSsid] = useState('');
  const [voicePuckWifiPassword, setVoicePuckWifiPassword] = useState('');
  const [voicePuckWifiMessage, setVoicePuckWifiMessage] = useState(null);
  const [voicePuckSync, setVoicePuckSync] = useState(null);

  const sessionRecorder = useAudioRecorder(SESSION_RECORDING_OPTIONS);
  const sessionRecorderState = useAudioRecorderState(sessionRecorder, 250);

  const handledCodeRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const speakNextReplyRef = useRef(false);
  const lastTurnWasVoiceRef = useRef(false);
  const geoSessionIdRef = useRef(newId('geo'));
  const sessionStartedAtRef = useRef(null);
  const sessionPlayerRef = useRef(null);
  const voicePuckRecordingLocationRef = useRef(null);
  const voicePuckSyncingRef = useRef(false);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: MOBILE_CLIENT_ID,
      responseType: AuthSession.ResponseType.Code,
      redirectUri,
      usePKCE: true,
      scopes: ['openid', 'profile', 'email', API_SCOPE],
      extraParams: {
        prompt: 'select_account',
      },
    },
    discovery
  );

  const firstName = useMemo(() => {
    const full = user?.name || user?.display_name || user?.username || 'Alice';
    return String(full).trim().split(/\s+/)[0] || 'Alice';
  }, [user]);

  const selectedSallyVoice = useMemo(
    () => sallyVoices.find((voice) => voice?.identifier === sallyVoice) || null,
    [sallyVoices, sallyVoice]
  );

  // ==========================================================
  // LOCAL DEVICE VOICE — TTS + ON-DEVICE STT
  // ==========================================================

  useEffect(() => {
    let mounted = true;

    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        if (!mounted || !Array.isArray(voices)) return;

        const englishVoices = voices.filter((voice) =>
          String(voice?.language || '').toLowerCase().startsWith('en')
        );

        // Prefer quality over accent: US Enhanced first, then any English
        // Enhanced voice, then US Default, then the first English voice.
        const preferred =
          englishVoices.find(
            (voice) =>
              String(voice?.language || '').toLowerCase().startsWith('en-us') &&
              String(voice?.quality || '').toLowerCase() === 'enhanced'
          ) ||
          englishVoices.find(
            (voice) => String(voice?.quality || '').toLowerCase() === 'enhanced'
          ) ||
          englishVoices.find((voice) =>
            String(voice?.language || '').toLowerCase().startsWith('en-us')
          ) ||
          englishVoices[0] ||
          null;

        setSallyVoices(englishVoices);
        setSallyVoice(preferred?.identifier || null);
      })
      .catch(() => {});

    return () => {
      mounted = false;
      Speech.stop();
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
      try {
        sessionPlayerRef.current?.release?.();
      } catch {}
    };
  }, []);

  useSpeechRecognitionEvent('start', () => {
    setRecognizing(true);
    setSpeechError(null);
    setVoiceDraftReady(false);
  });

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event?.results?.[0]?.transcript || '';
    if (transcript) setInput(transcript);
    if (event?.isFinal && transcript.trim()) {
      setVoiceDraftReady(true);
      speakNextReplyRef.current = true;
    }
  });

  useSpeechRecognitionEvent('end', () => {
    setRecognizing(false);
    setVoiceDraftReady((current) => current || !!input.trim());
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (event?.error === 'aborted') return;
    setRecognizing(false);
    setSpeechError(event?.message || event?.error || 'Speech recognition failed.');
  });

  function stopSpeaking() {
    Speech.stop();
    setSpeakingMessageId(null);
  }

  function speakText(value, messageId = null) {
    if (sessionRecorderState.isRecording || localSession?.status === 'recording') {
      setSpeechError('Sally audio is paused while a Session is recording.');
      return;
    }
    const speechText = prepareTextForSpeech(value);
    if (!speechText) return;

    Speech.stop();
    setSpeakingMessageId(messageId);

    Speech.speak(speechText, {
      language: 'en-US',
      voice: sallyVoice || undefined,
      rate: 0.94,
      pitch: 1.0,
      volume: 1.0,
      onDone: () => setSpeakingMessageId(null),
      onStopped: () => setSpeakingMessageId(null),
      onError: () => setSpeakingMessageId(null),
    });
  }

  async function toggleListening() {
    if (runtimeCapabilities?.voice?.ask_sally === false) {
      setSpeechError('Ask Sally voice is disabled by the demo administrator.');
      return;
    }
    if (sessionRecorderState.isRecording || localSession?.status === 'recording') {
      setSpeechError('Stop the active Session before using Sally voice input.');
      return;
    }

    if (recognizing) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }

    setSpeechError(null);
    stopSpeaking();

    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setSpeechError('Speech recognition is unavailable on this device.');
      return;
    }

    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
      setSpeechError('On-device speech recognition is unavailable for this device/locale.');
      return;
    }

    const permission = await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
    if (!permission?.granted) {
      setSpeechError('Microphone permission is required for voice input.');
      return;
    }

    speakNextReplyRef.current = true;
    setVoiceDraftReady(false);
    setInput('');

    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      maxAlternatives: 1,
      continuous: false,
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      contextualStrings: [...new Set([...SALLY_SPEECH_CONTEXT, ...runtimeSpeechContext])].slice(0, 300),
      iosTaskHint: 'dictation',
      iosCategory: {
        category: 'playAndRecord',
        categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
        mode: 'measurement',
      },
    });
  }

  // ==========================================================
  // AUTH CALLBACK
  // ==========================================================

  useEffect(() => {
    async function handleAuthResponse() {
      if (!response) return;

      if (response.type === 'cancel' || response.type === 'dismiss') {
        setAuthStatus('signed_out');
        return;
      }

      if (response.type === 'error') {
        setAuthError(response?.error?.message || JSON.stringify(response, null, 2));
        setAuthStatus('error');
        return;
      }

      if (response.type !== 'success') return;

      const code = response.params?.code;
      if (!code || handledCodeRef.current === code) return;
      handledCodeRef.current = code;

      try {
        setAuthStatus('exchanging_token');
        setAuthError(null);

        if (!request?.codeVerifier) {
          throw new Error('PKCE verifier is missing. Please try signing in again.');
        }

        const tokenResponse = await AuthSession.exchangeCodeAsync(
          {
            clientId: MOBILE_CLIENT_ID,
            code,
            redirectUri,
            extraParams: {
              code_verifier: request.codeVerifier,
            },
          },
          discovery
        );

        const token = tokenResponse?.accessToken;
        if (!token) throw new Error('Microsoft returned no access token.');

        setAccessToken(token);
        setAuthStatus('calling_api');

        const meResponse = await fetch(`${API_URL}/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const me = await parseResponse(meResponse);
        setUser(me);

        try {
          const capabilityResponse = await fetch(`${API_URL}/capabilities`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const capabilityBody = await parseResponse(capabilityResponse);
          setRuntimeCapabilities(capabilityBody?.capabilities || null);
          setRuntimeSpeechContext(Array.isArray(capabilityBody?.speech_context) ? capabilityBody.speech_context : []);
        } catch {
          // Do not block login if the optional capability refresh fails.
          setRuntimeCapabilities(null);
          setRuntimeSpeechContext([]);
        }

        setAuthStatus('authenticated');

        setMessages([
          {
            id: newId('welcome'),
            role: 'assistant',
            localOnly: true,
            text: `Hi ${String(me?.name || 'Alice').split(' ')[0]}. I’m Sally. Ask me about your accounts, opportunities, contacts or Salesforce meetings.`,
          },
        ]);
      } catch (error) {
        setAuthError(error?.message || String(error));
        setAuthStatus('error');
      }
    }

    handleAuthResponse();
  }, [response, request]);

  // ==========================================================
  // LOGIN / LOGOUT
  // ==========================================================

  async function login() {
    setAuthError(null);
    setAuthStatus('opening_login');
    handledCodeRef.current = null;

    try {
      await promptAsync();
    } catch (error) {
      setAuthError(error?.message || String(error));
      setAuthStatus('error');
    }
  }

  function logout() {
    Speech.stop();
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
    setSpeakingMessageId(null);
    setRecognizing(false);
    setVoiceDraftReady(false);
    speakNextReplyRef.current = false;
    lastTurnWasVoiceRef.current = false;
    setAccessToken(null);
    setUser(null);
    setRuntimeCapabilities(null);
    setRuntimeSpeechContext([]);
    setMessages([]);
    setInput('');
    setPendingConfirmation(null);
    setProcessingStatus(null);
    setProcessingEvents([]);
    setActiveChatJobId(null);
    setLastDebug(null);
    setDeviceLocation(null);
    setLocationContext(null);
    setLocationStatus('idle');
    setSessions([]);
    setSelectedSession(null);
    setSessionTranscript(null);
    setLocalSession(null);
    setActiveTab('chat');
    setAuthError(null);
    setAuthStatus('signed_out');
    handledCodeRef.current = null;
  }

  // ==========================================================
  // CHAT
  // ==========================================================

  async function sendMessage(messageOverride = null) {
    const message = (messageOverride ?? input).trim();
    if (!message || !accessToken || sending || confirming || recognizing) return;

    const shouldSpeakReply = messageOverride == null && speakNextReplyRef.current;
    lastTurnWasVoiceRef.current = shouldSpeakReply;
    speakNextReplyRef.current = false;

    const history = buildConversationHistory(messages);
    const clientContext = getClientContext(deviceLocation, geoSessionIdRef.current);
    const userMessage = { id: newId('user'), role: 'user', text: message };

    setMessages((current) => [...current, userMessage]);
    setInput('');
    setVoiceDraftReady(false);
    setSending(true);
    setProcessingStatus('Sending to Sally…');
    setProcessingEvents([]);
    setActiveChatJobId(null);
    setLastDebug(null);

    try {
      const startResponse = await fetch(`${API_URL}/chat/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, history, client_context: clientContext }),
      });
      const startBody = await parseResponse(startResponse);
      const jobId = startBody?.job_id;
      if (!jobId) throw new Error('Sally did not return a request id.');

      setActiveChatJobId(jobId);
      setProcessingStatus(startBody?.current_status || 'Sally is starting…');
      setProcessingEvents(Array.isArray(startBody?.events) ? startBody.events : []);

      let body = null;
      let polls = 0;
      while (!body && polls < 1200) {
        polls += 1;
        await sleep(polls < 8 ? 550 : 900);
        const statusResponse = await fetch(`${API_URL}/chat/jobs/${encodeURIComponent(jobId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const job = await parseResponse(statusResponse);
        setProcessingStatus(job?.current_status || null);
        setProcessingEvents(Array.isArray(job?.events) ? job.events : []);

        if (job?.state === 'failed') {
          throw new Error(job?.error?.message || 'Sally could not complete this request.');
        }
        if (job?.state === 'completed') {
          body = job?.result;
          break;
        }
      }
      if (!body) throw new Error('Sally is taking longer than expected. Please try again.');

      const status = body?.status || 'answered';
      const answer =
        body?.display_text ||
        body?.answer ||
        body?.message ||
        (status === 'confirmation_required'
          ? 'I prepared the Salesforce changes below. Review them before I write anything.'
          : 'Done.');
      const speechText = body?.speech_text || answer;

      const assistantMessage = {
        id: newId('assistant'),
        role: 'assistant',
        text: answer,
        speechText,
        historyText: body?.conversation_text || answer,
        uiBlocks: Array.isArray(body?.ui_blocks) ? body.ui_blocks : [],
        sources: Array.isArray(body?.web_sources) ? body.web_sources : [],
      };

      setMessages((current) => [...current, assistantMessage]);
      if (shouldSpeakReply) speakText(speechText, assistantMessage.id);

      setLastDebug({
        request_id: jobId,
        status,
        route: body?.route || null,
        router_model: body?.router_model || null,
        execution_model: body?.execution_model || null,
        tool_trace: body?.tool_trace || body?.tools || null,
        ui_blocks: Array.isArray(body?.ui_blocks) ? body.ui_blocks.map((b) => ({ type: b?.type, count: b?.count })) : [],
        capabilities: body?.capabilities || null,
        conversation_history_used: body?.conversation_history_used ?? history.length,
        client_context: clientContext,
        location_context: body?.location_context || null,
      });

      if (body?.capabilities) setRuntimeCapabilities(body.capabilities);
      if (body?.location_context) setLocationContext(body.location_context);

      if (status === 'confirmation_required') {
        const token = getConfirmationToken(body);
        const changes = getPendingChanges(body);
        if (!token) {
          throw new Error('Sally received a confirmation-required response, but the API did not include a confirmation token.');
        }
        setPendingConfirmation({ token, changes, raw: body });
      }
    } catch (error) {
      if (error?.status === 401) {
        setMessages((current) => [...current, { id: newId('error'), role: 'system', text: 'Your Microsoft session has expired. Sign in again to continue.' }]);
      } else {
        setMessages((current) => [...current, { id: newId('error'), role: 'system', text: `Request failed: ${error?.message || String(error)}` }]);
      }
    } finally {
      setSending(false);
      setProcessingStatus(null);
      setProcessingEvents([]);
      setActiveChatJobId(null);
      requestAnimationFrame(() => listRef.current?.scrollToEnd?.({ animated: true }));
    }
  }

  // ==========================================================
  // CONFIRM / CANCEL SALESFORCE WRITES
  // ==========================================================

  async function confirmChanges() {
    if (!pendingConfirmation?.token || !accessToken || confirming) return;

    setConfirming(true);

    try {
      const response = await fetch(`${API_URL}/confirm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmation_token: pendingConfirmation.token,
        }),
      });

      const body = await parseResponse(response);
      const updatedCount =
        body?.affected_count ??
        body?.updated_count ??
        body?.updatedCount ??
        (Array.isArray(body?.results) ? body.results.length : null);

      setPendingConfirmation(null);

      const results = Array.isArray(body?.results) ? body.results : [];
      const createdOpportunity = results.find((item) => item?.action === 'create_opportunity');
      const createdTask = results.find((item) => item?.action === 'create_task');
      const createdEvent = results.find((item) => item?.action === 'create_event');

      const confirmationText = createdOpportunity
        ? `Done — I created ${createdOpportunity.opportunity_name || 'the opportunity'} in Salesforce${createdOpportunity.project_number ? ` with project number ${createdOpportunity.project_number}` : ''}.`
        : createdTask
          ? `Done — I created the Salesforce task “${createdTask.task_subject || 'Task'}”.`
          : createdEvent
            ? `Done — I created the Salesforce event “${createdEvent.event_subject || 'Event'}”.`
            : updatedCount != null
              ? `Done — Salesforce confirmed ${updatedCount} change${updatedCount === 1 ? '' : 's'}.`
              : 'Done — Salesforce confirmed the change.';

      const confirmationMessage = {
        id: newId('confirmed'),
        role: 'assistant',
        text: confirmationText,
      };

      setMessages((current) => [...current, confirmationMessage]);

      if (lastTurnWasVoiceRef.current) {
        speakText(confirmationText, confirmationMessage.id);
      }

      setLastDebug((current) => ({
        ...(current || {}),
        confirmation_result: body,
      }));
    } catch (error) {
      const partialWrite = error?.body?.error === 'confirmation_partial';
      if (partialWrite) {
        // A create may already exist in Salesforce. Remove the old confirmation card
        // so the user cannot accidentally create a duplicate by tapping Confirm again.
        setPendingConfirmation(null);
      }
      setMessages((current) => [
        ...current,
        {
          id: newId('confirm-error'),
          role: 'system',
          text: partialWrite
            ? `Salesforce made part of that create, but Sally could not finish or verify every step. Do not retry the same create yet. ${error?.message || ''}`.trim()
            : `I couldn't apply that Salesforce change: ${error?.message || String(error)}`,
        },
      ]);
    } finally {
      setConfirming(false);
      requestAnimationFrame(() => listRef.current?.scrollToEnd?.({ animated: true }));
    }
  }

  function cancelChanges() {
    setPendingConfirmation(null);
    setMessages((current) => [
      ...current,
      {
        id: newId('cancelled'),
        role: 'assistant',
        text: 'Cancelled. Nothing was written to Salesforce.',
      },
    ]);
  }

  // ==========================================================
  // DEMO CAPABILITY FLAGS
  // ==========================================================

  async function refreshRuntimeCapabilities() {
    if (!accessToken) return null;
    try {
      const response = await fetch(`${API_URL}/capabilities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await parseResponse(response);
      const capabilities = body?.capabilities || null;
      if (capabilities) setRuntimeCapabilities(capabilities);
      setRuntimeSpeechContext(Array.isArray(body?.speech_context) ? body.speech_context : []);
      return capabilities;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (authStatus !== 'authenticated' || !accessToken) return undefined;
    const timer = setInterval(() => {
      refreshRuntimeCapabilities().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [authStatus, accessToken]);

  // ==========================================================
  // LOCATION
  // ==========================================================

  async function refreshLocation({ resolveDemo = true } = {}) {
    if (!accessToken) return null;
    if (runtimeCapabilities?.location?.foreground_gps === false) {
      setLocationStatus('disabled');
      setLocationError('Location is disabled by the demo administrator.');
      return null;
    }
    setLocationStatus('locating');
    setLocationError(null);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationStatus('denied');
        setLocationError('Location permission was not granted.');
        return null;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      let address = null;
      try {
        const addresses = await Location.reverseGeocodeAsync({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        address = addresses?.[0] || null;
      } catch {}

      const snapshot = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy_m: position.coords.accuracy,
        city: address?.city || address?.district || null,
        region: address?.region || null,
        country: address?.country || null,
        iso_country_code: address?.isoCountryCode || null,
        captured_at: new Date(position.timestamp || Date.now()).toISOString(),
      };

      setDeviceLocation(snapshot);
      setLocationStatus('ready');

      if (resolveDemo) {
        const response = await fetch(`${API_URL}/location/resolve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_context: getClientContext(snapshot, geoSessionIdRef.current),
          }),
        });
        const body = await parseResponse(response);
        setLocationContext(body?.location_context || null);
      }
      return snapshot;
    } catch (error) {
      setLocationStatus('error');
      setLocationError(error?.message || String(error));
      return null;
    }
  }

  useEffect(() => {
    if (authStatus === 'authenticated' && accessToken) {
      refreshLocation().catch(() => {});
      loadSessions().catch(() => {});
    }
  }, [authStatus, accessToken]);

  // ==========================================================
  // VOICEPUCK — PHONE-SIDE BLE CONTROL STATE
  // ==========================================================

  useEffect(() => {
    const unsubscribe = VoicePuck.subscribe((snapshot) => {
      const safeSnapshot = snapshot || {};
      setVoicePuckState(safeSnapshot);
      setVoicePuckDevices(Array.isArray(safeSnapshot?.devices) ? safeSnapshot.devices : []);

      if (safeSnapshot?.connected) {
        setVoicePuckScanState('connected');
        setVoicePuckError(null);
        // Auto-reconnect should behave like a manual connection: when the Puck
        // is available, make it the default Session source unless an iPhone
        // recording is already in progress.
        setSessionSource((current) => current === 'iphone' ? 'voicepuck' : current);
      } else if (safeSnapshot?.reconnecting) {
        setVoicePuckScanState('reconnecting');
      }

      if (safeSnapshot?.error) setVoicePuckError(safeSnapshot.error);

      if (safeSnapshot?.state === 'recording' && safeSnapshot?.active_session_id) {
        setSessionSource('voicepuck');
        setLocalSession((current) => {
          if (current?.source === 'iphone') return current;
          return {
            ...(current || {}),
            session_id: safeSnapshot.active_session_id,
            status: 'recording',
            source: 'voicepuck',
            started_at: current?.started_at || new Date().toISOString(),
            location: current?.location || voicePuckRecordingLocationRef.current || null,
            voicepuck: safeSnapshot,
          };
        });
      } else if (safeSnapshot?.state !== 'recording') {
        // IMPORTANT: a physical-button stop must stop the iPhone timer too.
        // FINAL-04 sends last_session_id, but we also fall back to the Session
        // id already learned while recording so a missed/older notification
        // cannot leave Sally stuck in "Recording".
        setLocalSession((current) => {
          if (current?.source !== 'voicepuck' || current?.status !== 'recording') return current;
          return {
            ...current,
            session_id: safeSnapshot?.last_session_id || current?.session_id,
            status: 'pending_sync',
            voicepuck: safeSnapshot,
          };
        });
      }
    });

    return unsubscribe;
  }, []);

  // ==========================================================
  // SESSIONS — IPHONE PRIMARY RECORDER
  // ==========================================================

  async function loadSessions({ silent = false } = {}) {
    if (!accessToken) return;
    if (!silent) setSessionsLoading(true);
    try {
      const response = await fetch(`${API_URL}/sessions`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await parseResponse(response);
      setSessions(Array.isArray(body?.sessions) ? body.sessions : []);
    } catch (error) {
      if (!silent) {
        setLocalSession((current) => current || {
          session_id: newId('local-error'),
          status: 'error',
          error: `Could not load Sessions: ${error?.message || String(error)}`,
        });
      }
    } finally {
      if (!silent) setSessionsLoading(false);
    }
  }

  async function loadSessionDetail(sessionId, { silent = false } = {}) {
    if (!accessToken || !sessionId) return;
    if (!silent) setSessionActionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await parseResponse(response);
      setSelectedSession(body?.session || null);
    } finally {
      if (!silent) setSessionActionBusy(false);
    }
  }

  useEffect(() => {
    if (authStatus !== 'authenticated' || !accessToken) return undefined;
    const needsPolling =
      activeTab === 'sessions' &&
      (sessions.some((session) => ['uploaded', 'transcribing', 'analyzing'].includes(session?.status)) ||
        ['uploaded', 'transcribing', 'analyzing'].includes(selectedSession?.status));
    if (!needsPolling) return undefined;

    const timer = setInterval(() => {
      loadSessions({ silent: true }).catch(() => {});
      if (selectedSession?.session_id) {
        loadSessionDetail(selectedSession.session_id, { silent: true }).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [authStatus, accessToken, activeTab, sessions, selectedSession?.session_id, selectedSession?.status]);

  async function startSessionRecording() {
    if (sessionSource === 'voicepuck') {
      return startVoicePuckRecording();
    }
    if (runtimeCapabilities?.sessions?.iphone_recording === false) {
      setLocalSession({
        session_id: newId('sess-disabled'),
        status: 'error',
        error: 'Session recording is disabled by the demo administrator.',
      });
      return;
    }
    if (recognizing || sending || confirming) return;
    setSessionActionBusy(true);
    setSessionTranscript(null);

    try {
      stopSpeaking();
      try { ExpoSpeechRecognitionModule.abort(); } catch {}

      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission?.granted) {
        throw new Error('Microphone permission is required to record a Session.');
      }

      const sessionLocation = deviceLocation || await refreshLocation({ resolveDemo: false }).catch(() => null);

      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
      });

      await sessionRecorder.prepareToRecordAsync();
      sessionStartedAtRef.current = new Date();
      sessionRecorder.record();

      setLocalSession({
        session_id: newId('sess'),
        status: 'recording',
        source: 'iphone',
        started_at: sessionStartedAtRef.current.toISOString(),
        location: sessionLocation || deviceLocation || null,
        voicepuck: EMPTY_VOICEPUCK,
      });
    } catch (error) {
      setLocalSession({
        session_id: newId('sess-error'),
        status: 'error',
        error: error?.message || String(error),
      });
      try {
        await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
      } catch {}
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function persistRecordedFile(sessionId, sourceUri) {
    if (!sourceUri) throw new Error('Recorder did not return an audio file.');
    const directory = new Directory(Paths.document, 'cmd-sally-sessions');
    directory.create({ idempotent: true, intermediates: true });
    const source = new File(sourceUri);
    const destination = new File(directory, `${sessionId}.m4a`);
    if (destination.exists) destination.delete();
    source.copy(destination);
    return destination;
  }

  async function uploadLocalSession(sessionData, localFile) {
    if (!accessToken || !sessionData || !localFile) return;
    setLocalSession((current) => ({ ...current, status: 'uploading', local_uri: localFile.uri }));

    try {
      const formData = new FormData();
      formData.append('audio', localFile);
      formData.append('metadata', JSON.stringify({
        session_id: sessionData.session_id,
        source: 'iphone',
        started_at: sessionData.started_at,
        ended_at: sessionData.ended_at,
        duration_ms: sessionData.duration_ms,
        location: sessionData.location || deviceLocation || null,
        geo_session_id: geoSessionIdRef.current,
        voicepuck: EMPTY_VOICEPUCK,
      }));

      const response = await expoFetch(`${API_URL}/sessions/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const body = await parseResponse(response);
      if (body?.location_context) setLocationContext(body.location_context);

      // The backend has acknowledged and stored the original recording.
      try { if (localFile.exists) localFile.delete(); } catch {}
      setLocalSession(null);
      await loadSessions({ silent: true });
      if (body?.session?.session_id) {
        setSelectedSession(body.session);
      }
      return body;
    } catch (error) {
      setLocalSession((current) => ({
        ...current,
        status: 'upload_failed',
        local_uri: localFile.uri,
        error: error?.message || String(error),
      }));
      throw error;
    }
  }

  async function stopSessionRecording() {
    if (localSession?.source === 'voicepuck' || voicePuckState?.state === 'recording') {
      return stopVoicePuckRecording();
    }
    if (!sessionRecorderState.isRecording && localSession?.status !== 'recording') return;
    setSessionActionBusy(true);

    try {
      await sessionRecorder.stop();
      const endedAt = new Date();
      const startedAt = sessionStartedAtRef.current || new Date(endedAt.getTime() - Number(sessionRecorderState.durationMillis || 0));
      const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
      const sessionData = {
        ...(localSession || {}),
        session_id: localSession?.session_id || newId('sess'),
        source: 'iphone',
        status: 'recorded',
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        location: localSession?.location || deviceLocation || null,
        voicepuck: EMPTY_VOICEPUCK,
      };

      const localFile = await persistRecordedFile(sessionData.session_id, sessionRecorder.uri);
      setLocalSession({ ...sessionData, status: 'recorded', local_uri: localFile.uri });

      try {
        await setAudioModeAsync({
          allowsRecording: false,
          allowsBackgroundRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        });
      } catch {}

      await uploadLocalSession(sessionData, localFile);
    } catch (error) {
      setLocalSession((current) => ({
        ...(current || {}),
        status: current?.local_uri ? 'upload_failed' : 'error',
        error: error?.message || String(error),
      }));
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function retryLocalSessionUpload() {
    if (!localSession?.local_uri) return;
    const file = new File(localSession.local_uri);
    if (!file.exists) {
      setLocalSession((current) => ({ ...current, status: 'error', error: 'The local recording file is missing.' }));
      return;
    }
    setSessionActionBusy(true);
    try {
      await uploadLocalSession(localSession, file);
    } catch {} finally {
      setSessionActionBusy(false);
    }
  }

  async function retryServerProcessing(sessionId) {
    setSessionActionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      await parseResponse(response);
      await loadSessionDetail(sessionId, { silent: true });
      await loadSessions({ silent: true });
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function openSession(session) {
    setSelectedSession(session);
    setSessionTranscript(null);
    setSessionLinkOptions([]);
    await loadSessionDetail(session.session_id).catch(() => {});
  }

  async function loadTranscript(sessionId) {
    setSessionActionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/transcript`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await parseResponse(response);
      setSessionTranscript(body);
    } catch (error) {
      setSessionTranscript({ error: error?.message || String(error), segments: [] });
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function playSessionAudio(sessionId) {
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch {}
    try {
      sessionPlayerRef.current?.release?.();
    } catch {}
    const player = createAudioPlayer({
      uri: `${API_URL}/sessions/${encodeURIComponent(sessionId)}/audio`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    sessionPlayerRef.current = player;
    player.play();
  }

  async function loadLinkOptions() {
    setSessionActionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/link-options`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await parseResponse(response);
      setSessionLinkOptions(Array.isArray(body?.opportunities) ? body.opportunities : []);
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function linkSessionOpportunity(sessionId, opportunityId) {
    setSessionActionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/link-opportunity`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ opportunity_id: opportunityId || null }),
      });
      const body = await parseResponse(response);
      setSelectedSession(body?.session || null);
      setSessionLinkOptions([]);
      await loadSessions({ silent: true });
    } finally {
      setSessionActionBusy(false);
    }
  }

  function deleteSessionFromList(session) {
    if (runtimeCapabilities?.sessions?.soft_delete === false) {
      Alert.alert('Delete disabled', 'Session soft delete is disabled by the demo administrator.');
      return;
    }
    if (!session?.session_id || !accessToken) return;
    if (['uploaded', 'transcribing', 'analyzing'].includes(session?.status)) {
      Alert.alert('Session is still processing', 'Wait for processing to finish before deleting this Session.');
      return;
    }

    Alert.alert(
      'Delete this Session?',
      'It will disappear from Previous Sessions. For this demo, Sally keeps an archived copy that only the admin can restore.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSessionActionBusy(true);
            try {
              const response = await fetch(`${API_URL}/sessions/${encodeURIComponent(session.session_id)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              await parseResponse(response);
              if (selectedSession?.session_id === session.session_id) {
                setSelectedSession(null);
                setSessionTranscript(null);
                setSessionLinkOptions([]);
              }
              await loadSessions({ silent: true });
            } catch (error) {
              Alert.alert('Could not delete Session', error?.message || String(error));
            } finally {
              setSessionActionBusy(false);
            }
          },
        },
      ]
    );
  }

  async function scanVoicePucks() {
    if (voicePuckScanState === 'scanning' || !voicePuckState?.supported) return;
    setVoicePuckError(null);
    setVoicePuckScanState('scanning');
    try {
      const devices = await VoicePuck.scan();
      setVoicePuckDevices(devices || []);
      setVoicePuckScanState(devices?.length ? 'found' : 'none_found');
    } catch (error) {
      setVoicePuckScanState('error');
      setVoicePuckError(error?.message || String(error));
    }
  }

  async function connectVoicePuck(deviceId) {
    setVoicePuckBusy(true);
    setVoicePuckError(null);
    try {
      await VoicePuck.connect(deviceId);
      setVoicePuckScanState('connected');
      setSessionSource('voicepuck');
    } catch (error) {
      setVoicePuckError(error?.message || String(error));
    } finally {
      setVoicePuckBusy(false);
    }
  }

  async function disconnectVoicePuck() {
    setVoicePuckBusy(true);
    try {
      await VoicePuck.disconnect();
      setSessionSource('iphone');
      setVoicePuckScanState('idle');
    } finally {
      setVoicePuckBusy(false);
    }
  }

  async function provisionVoicePuckWifi() {
    setVoicePuckBusy(true);
    setVoicePuckError(null);
    setVoicePuckWifiMessage('Checking Wi-Fi on VoicePuck…');
    try {
      await VoicePuck.provisionWifi(voicePuckWifiSsid, voicePuckWifiPassword);
      setVoicePuckWifiPassword('');
      setVoicePuckWifiMessage(`Wi-Fi verified and saved${voicePuckWifiSsid?.trim() ? ` · ${voicePuckWifiSsid.trim()}` : ''}`);
    } catch (error) {
      const message = error?.message || String(error);
      setVoicePuckWifiMessage(message);
      setVoicePuckError(message);
    } finally {
      setVoicePuckBusy(false);
    }
  }

  async function startVoicePuckRecording() {
    if (!voicePuckState?.connected) {
      setVoicePuckError('Connect a VoicePuck before starting from the app. The physical button can still record offline.');
      return;
    }
    setVoicePuckBusy(true);
    setVoicePuckError(null);
    try {
      stopSpeaking();
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      const recordingLocation = deviceLocation || await refreshLocation({ resolveDemo: false }).catch(() => null);
      voicePuckRecordingLocationRef.current = recordingLocation || null;
      setLocalSession({
        session_id: newId('vp-starting'),
        status: 'voicepuck_starting',
        source: 'voicepuck',
        started_at: new Date().toISOString(),
        location: recordingLocation || null,
        voicepuck: voicePuckState,
      });
      await VoicePuck.startRecording();
    } catch (error) {
      setLocalSession(null);
      setVoicePuckError(error?.message || String(error));
    } finally {
      setVoicePuckBusy(false);
    }
  }

  async function stopVoicePuckRecording() {
    if (!voicePuckState?.connected) {
      setVoicePuckError('VoicePuck disconnected. Stop the recording with its physical button; Sally will discover it when you reconnect.');
      return;
    }
    setVoicePuckBusy(true);
    try {
      await VoicePuck.stopRecording();
      setLocalSession((current) => current?.source === 'voicepuck' ? { ...current, status: 'pending_sync' } : current);
    } catch (error) {
      setVoicePuckError(error?.message || String(error));
    } finally {
      setVoicePuckBusy(false);
    }
  }

  async function syncVoicePuckSession(sessionId, { manual = false } = {}) {
    const canonicalDeviceId = String(voicePuckState?.device_id || '');
    if (!accessToken || !voicePuckState?.connected || !sessionId) return;

    // Wait for the Puck's own VP-xxxxxx identity. CoreBluetooth's device UUID
    // is only a transport id and must never be used to mint a backend ticket.
    if (!canonicalDeviceId.startsWith('VP-')) {
      if (manual) setVoicePuckError('VoicePuck is connected, but Sally is still reading its device identity. Try again in a moment.');
      return;
    }

    if (voicePuckSyncingRef.current) return;
    voicePuckSyncingRef.current = true;
    setVoicePuckBusy(true);
    setVoicePuckError(null);
    setVoicePuckSync({ session_id: sessionId, state: 'checking_server', received_chunks: 0, total_chunks: 0 });

    const finishCompletedServerSession = async (serverSync, serverAckId) => {
      try {
        await VoicePuck.acknowledgeSyncedSession(sessionId, serverAckId);
        setVoicePuckSync({ ...(serverSync || {}), session_id: sessionId, state: 'acked_for_delete' });
      } catch (ackError) {
        if (ackError?.code !== 'voicepuck_delete_ack_not_confirmed') throw ackError;

        // Legacy test builds could complete server upload before they learned to
        // persist server_ack.txt. Never delete that local audio blindly. Move it
        // to /voicepuck/legacy_hold so it no longer blocks the fresh sync queue.
        setVoicePuckSync({ ...(serverSync || {}), session_id: sessionId, state: 'archiving_legacy_local_copy' });
        await VoicePuck.archiveLegacySession(sessionId);
        setVoicePuckSync({
          ...(serverSync || {}),
          session_id: sessionId,
          state: 'server_complete_local_archived',
          note: 'Server copy verified. Legacy local copy preserved in /voicepuck/legacy_hold.',
        });
      }

      setLocalSession((current) => current?.source === 'voicepuck' && current?.session_id === sessionId ? null : current);
      await loadSessions({ silent: true });
      voicePuckRecordingLocationRef.current = null;
    };

    try {
      // Recovery comes first. If the Puck uploaded successfully but BLE dropped
      // before the phone sent the final delete ACK, the server already has a
      // completed ticket. Reuse that ACK instead of issuing another upload.
      const previousResponse = await fetch(`${API_URL}/voicepuck/sync-status/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (previousResponse.ok) {
        const previousBody = await parseResponse(previousResponse);
        const previous = previousBody?.sync;
        if (previous?.state === 'completed' && previous?.server_ack_id) {
          setVoicePuckSync({ ...previous, state: 'recovering_delete_ack' });
          await finishCompletedServerSession(previous, previous.server_ack_id);
          return;
        }
      } else if (previousResponse.status !== 404) {
        await parseResponse(previousResponse);
      }

      // A recovered delete ACK only needs BLE + the phone's own network. New
      // audio upload, however, needs the Puck itself to be on Wi-Fi.
      if (!voicePuckState?.wifi_connected) {
        setVoicePuckSync((current) => ({ ...(current || {}), session_id: sessionId, state: 'waiting_for_voicepuck_wifi' }));
        if (manual) setVoicePuckError('The recording is safe on VoicePuck. Connect the Puck to Wi-Fi, then sync again.');
        return;
      }

      setVoicePuckSync((current) => ({ ...(current || {}), session_id: sessionId, state: 'issuing_ticket' }));
      const ticketResponse = await fetch(`${API_URL}/voicepuck/sync-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: canonicalDeviceId,
          session_id: sessionId,
          recording_location: localSession?.source === 'voicepuck' && localSession?.session_id === sessionId
            ? (localSession?.location || voicePuckRecordingLocationRef.current || null)
            : null,
        }),
      });
      const ticket = await parseResponse(ticketResponse);

      // The sync-ticket endpoint also has a duplicate-safe recovery path in
      // case the Session became complete between the status check and this POST.
      if (ticket?.status === 'already_completed' && ticket?.server_ack_id) {
        const recovered = ticket?.sync || { session_id: sessionId, server_ack_id: ticket.server_ack_id };
        setVoicePuckSync({ ...recovered, state: 'recovering_delete_ack' });
        await finishCompletedServerSession(recovered, ticket.server_ack_id);
        return;
      }

      setVoicePuckSync((current) => ({ ...current, state: 'ticket_issued', expires_at: ticket.expires_at }));

      // Only the short-lived, Session-bound upload ticket reaches the Puck — never Alice's Entra token.
      await VoicePuck.syncSession(sessionId, ticket.ticket_id, ticket.ticket_secret);
      setVoicePuckSync((current) => ({ ...current, state: 'uploading' }));

      for (let attempt = 0; attempt < 150; attempt += 1) {
        await sleep(2000);
        const statusResponse = await fetch(`${API_URL}/voicepuck/sync-status/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const statusBody = await parseResponse(statusResponse);
        const sync = statusBody?.sync;
        if (sync) setVoicePuckSync(sync);
        if (sync?.state === 'completed' && sync?.server_ack_id) {
          await finishCompletedServerSession(sync, sync.server_ack_id);
          return;
        }
      }
      throw new Error('VoicePuck upload is taking longer than expected. The recording remains on the Puck; tap Sync pending to continue.');
    } catch (error) {
      setVoicePuckSync((current) => ({ ...(current || {}), session_id: sessionId, state: 'error', error: error?.message || String(error) }));
      setVoicePuckError(error?.message || String(error));
    } finally {
      voicePuckSyncingRef.current = false;
      setVoicePuckBusy(false);
    }
  }

  useEffect(() => {
    const pending = Array.isArray(voicePuckState?.pending_sessions)
      ? voicePuckState.pending_sessions[0]
      : null;
    const canonicalDeviceId = String(voicePuckState?.device_id || '');

    const ready = Boolean(
      pending &&
      accessToken &&
      voicePuckState?.connected &&
      voicePuckState?.wifi_connected &&
      canonicalDeviceId.startsWith('VP-') &&
      voicePuckState?.state !== 'recording'
    );

    if (!ready) return undefined;

    let cancelled = false;

    const attempt = () => {
      if (cancelled || voicePuckSyncingRef.current) return;
      syncVoicePuckSession(pending, { manual: false }).catch(() => {});
    };

    // Give the final manifest/state notification and reconnect identity a short
    // settling window, then retry periodically until the pending Session leaves
    // the Puck. This intentionally mirrors the manual Sync action.
    const firstTimer = setTimeout(attempt, 1200);
    const retryTimer = setInterval(attempt, 7000);

    return () => {
      cancelled = true;
      clearTimeout(firstTimer);
      clearInterval(retryTimer);
    };
  }, [
    accessToken,
    voicePuckState?.connected,
    voicePuckState?.wifi_connected,
    voicePuckState?.device_id,
    voicePuckState?.state,
    JSON.stringify(voicePuckState?.pending_sessions || []),
  ]);

  // ==========================================================
  // AUTH SCREENS
  // ==========================================================

  if (authStatus !== 'authenticated') {
    const loading = ['opening_login', 'exchanging_token', 'calling_api'].includes(authStatus);

    return (
      <SafeAreaView style={styles.authScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.authWrap}>
          <View>
            <Text style={styles.brand}>CMD Sally</Text>
            <Text style={styles.authTagline}>Your AI sales partner.</Text>
          </View>

          <View style={styles.authCard}>
            {loading ? (
              <>
                <ActivityIndicator size="large" />
                <Text style={styles.authLoadingText}>
                  {authStatus === 'opening_login' && 'Opening Microsoft…'}
                  {authStatus === 'exchanging_token' && 'Signing you in…'}
                  {authStatus === 'calling_api' && 'Connecting Sally…'}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.authTitle}>Enter Demo Workspace</Text>
                <Text style={styles.authBody}>
                  Sign in using the Microsoft demo account provided for this pilot.
                </Text>

                <TouchableOpacity
                  style={[styles.primaryButton, !request && styles.disabledButton]}
                  disabled={!request}
                  onPress={login}
                >
                  <Text style={styles.primaryButtonText}>Continue with Microsoft</Text>
                </TouchableOpacity>
              </>
            )}

            {authStatus === 'error' && !!authError && (
              <View style={styles.authErrorBox}>
                <Text style={styles.authErrorTitle}>Sign-in failed</Text>
                <Text selectable style={styles.authErrorText}>{authError}</Text>
                <TouchableOpacity onPress={() => setAuthStatus('signed_out')}>
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <Text selectable style={styles.redirectDebug}>Redirect: {redirectUri}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ==========================================================
  // MAIN APP UI
  // ==========================================================

  const effectiveLocationLabel =
    locationContext?.effective?.label ||
    locationDisplayLabel(locationContext?.effective) ||
    locationDisplayLabel(deviceLocation);
  const locationIsDemo = locationContext?.mode === 'demo';

  const chatWorkspace = (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 4 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.messageList, !isCompact && styles.centeredContent]}
        onContentSizeChange={() => listRef.current?.scrollToEnd?.({ animated: true })}
        renderItem={({ item }) => (
          <MessageBubble
            item={item}
            speakingMessageId={speakingMessageId}
            onSpeak={speakText}
            onStopSpeak={stopSpeaking}
          />
        )}
        ListFooterComponent={
          <>
            {sending && (
              <ProcessingStatusCard status={processingStatus} events={processingEvents} requestId={activeChatJobId} />
            )}
            {!!pendingConfirmation && (
              <ConfirmationCard changes={pendingConfirmation.changes} confirming={confirming} onConfirm={confirmChanges} onCancel={cancelChanges} />
            )}
          </>
        }
      />

      {messages.length <= 1 && !sending && !pendingConfirmation && (
        <View style={[styles.quickPromptsWrap, !isCompact && styles.centeredContent]}>
          <Text style={styles.quickPromptsLabel}>Try asking</Text>
          <View style={[styles.quickPromptsRow, !isCompact && styles.quickPromptsRowWide]}>
            <QuickPrompt text="What opportunities are closing this month?" onPress={sendMessage} />
            <QuickPrompt text="Do I have any overdue opportunities?" onPress={sendMessage} />
            <QuickPrompt text="Who can I visit near me?" onPress={sendMessage} />
          </View>
        </View>
      )}

      <View style={[styles.composerWrap, !isCompact && styles.centeredContent]}>
        <View style={styles.composer}>
          <TouchableOpacity
            style={[styles.micButton, recognizing && styles.micButtonActive]}
            disabled={!!pendingConfirmation || sending || confirming || localSession?.status === 'recording' || runtimeCapabilities?.voice?.ask_sally === false}
            onPress={toggleListening}
          >
            <Text style={[styles.micText, recognizing && styles.micTextActive]}>{recognizing ? '■' : '🎤'}</Text>
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={input}
            onChangeText={(value) => { setInput(value); if (!recognizing) setVoiceDraftReady(false); }}
            placeholder={pendingConfirmation ? 'Resolve the Salesforce change first' : 'Ask Sally…'}
            placeholderTextColor="#8D8D8D"
            multiline
            maxLength={4000}
            editable={!pendingConfirmation && !sending && !confirming && !recognizing}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => { if (!input.includes('\n')) sendMessage(); }}
          />
          <TouchableOpacity
            style={[styles.sendButton, (!input.trim() || sending || confirming || pendingConfirmation || recognizing) && styles.sendButtonDisabled]}
            disabled={!input.trim() || sending || confirming || !!pendingConfirmation || recognizing}
            onPress={() => sendMessage()}
          >
            <Text style={styles.sendButtonText}>↑</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.composerHint, (recognizing || voiceDraftReady) && styles.voiceHint]}>
          {localSession?.status === 'recording'
            ? `${localSession?.source === 'voicepuck' ? 'VoicePuck' : 'Session'} recording is active · text chat works, voice input is paused.`
            : recognizing
              ? 'Listening on-device · tap ■ to stop.'
              : voiceDraftReady
                ? 'Voice transcript ready · review it, then tap ↑. Sally will speak the reply.'
                : speechError || 'Salesforce writes always require review before they are applied.'}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );

  const sessionsWorkspace = (
    <SessionsWorkspace
      sessions={sessions}
      sessionsLoading={sessionsLoading}
      localSession={localSession}
      recorderState={sessionRecorderState}
      selectedSession={selectedSession}
      transcript={sessionTranscript}
      linkOptions={sessionLinkOptions}
      busy={sessionActionBusy || voicePuckBusy}
      sessionSource={sessionSource}
      onSelectSource={setSessionSource}
      voicePuckState={voicePuckState}
      voicePuckDevices={voicePuckDevices}
      voicePuckScanState={voicePuckScanState}
      voicePuckError={voicePuckError}
      voicePuckWifiSsid={voicePuckWifiSsid}
      voicePuckWifiPassword={voicePuckWifiPassword}
      voicePuckWifiMessage={voicePuckWifiMessage}
      voicePuckSync={voicePuckSync}
      onWifiSsid={setVoicePuckWifiSsid}
      onWifiPassword={setVoicePuckWifiPassword}
      onStart={startSessionRecording}
      onStop={stopSessionRecording}
      onRetryUpload={retryLocalSessionUpload}
      onRefresh={() => loadSessions()}
      onOpenSession={openSession}
      onCloseSession={() => { setSelectedSession(null); setSessionTranscript(null); setSessionLinkOptions([]); }}
      onLoadTranscript={loadTranscript}
      onPlayAudio={playSessionAudio}
      onRetryProcessing={retryServerProcessing}
      onLoadLinkOptions={loadLinkOptions}
      onLinkOpportunity={linkSessionOpportunity}
      onDeleteSession={deleteSessionFromList}
      onScanVoicePuck={scanVoicePucks}
      onConnectVoicePuck={connectVoicePuck}
      onDisconnectVoicePuck={disconnectVoicePuck}
      onProvisionVoicePuckWifi={provisionVoicePuckWifi}
      onSyncVoicePuck={(sid) => syncVoicePuckSession(sid, { manual: true })}
      locationContext={locationContext}
      recordingAllowed={runtimeCapabilities?.sessions?.iphone_recording !== false}
      voicePuckAllowed={runtimeCapabilities?.sessions?.voicepuck !== false}
      deleteAllowed={runtimeCapabilities?.sessions?.soft_delete !== false}
      layoutMode={layoutMode}
    />
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.headerBrand}>CMD Sally</Text>
          <View style={styles.connectedRow}><View style={styles.connectedDot} /><Text style={styles.connectedText}>{firstName} · Salesforce connected</Text></View>
          <TouchableOpacity onPress={() => refreshLocation()} disabled={locationStatus === 'locating'}>
            <Text style={[styles.locationBadge, locationIsDemo && styles.locationBadgeDemo]}>
              {locationStatus === 'locating' ? '📍 Locating…' : effectiveLocationLabel ? `📍 ${locationIsDemo ? 'Demo location · ' : ''}${effectiveLocationLabel}` : '📍 Location unavailable · tap to retry'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.headerActions}>
          <View style={styles.layoutPill}><Text style={styles.layoutPillText}>{layoutMode.toUpperCase()}</Text></View>
          <TouchableOpacity style={styles.devButton} onPress={() => setShowDebug((v) => !v)}><Text style={styles.devButtonText}>DEV</Text></TouchableOpacity>
          <TouchableOpacity style={styles.avatar} onPress={logout}><Text style={styles.avatarText}>{firstName.slice(0, 1).toUpperCase()}</Text></TouchableOpacity>
        </View>
      </View>

      {isCompact && (
        <View style={styles.topTabs}>
          <TouchableOpacity style={[styles.topTab, activeTab === 'chat' && styles.topTabActive]} onPress={() => setActiveTab('chat')}><Text style={[styles.topTabText, activeTab === 'chat' && styles.topTabTextActive]}>Chat</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.topTab, activeTab === 'sessions' && styles.topTabActive]} onPress={() => { setActiveTab('sessions'); loadSessions().catch(() => {}); }}><Text style={[styles.topTabText, activeTab === 'sessions' && styles.topTabTextActive]}>Sessions</Text>{!!sessions.length && <View style={styles.tabCount}><Text style={styles.tabCountText}>{sessions.length}</Text></View>}</TouchableOpacity>
        </View>
      )}

      <View style={styles.responsiveBody}>
        {!isCompact && (
          <View style={styles.navRail}>
            <Text style={styles.navEyebrow}>WORKSPACE</Text>
            <TouchableOpacity style={[styles.navItem, activeTab === 'chat' && styles.navItemActive]} onPress={() => setActiveTab('chat')}><Text style={[styles.navItemText, activeTab === 'chat' && styles.navItemTextActive]}>Chat</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.navItem, activeTab === 'sessions' && styles.navItemActive]} onPress={() => { setActiveTab('sessions'); loadSessions().catch(() => {}); }}><Text style={[styles.navItemText, activeTab === 'sessions' && styles.navItemTextActive]}>Sessions {sessions.length ? `· ${sessions.length}` : ''}</Text></TouchableOpacity>
            <View style={styles.navDivider} />
            <Text style={styles.navEyebrow}>VOICEPUCK</Text>
            <Text style={styles.navStatus}>{voicePuckState?.connected ? '● Connected' : '○ Not connected'}</Text>
            {!!voicePuckState?.pending_sessions?.length && <Text style={styles.navStatus}>{voicePuckState.pending_sessions.length} pending sync</Text>}
          </View>
        )}

        <View style={styles.primaryPane}>
          {showDebug && (
            <View style={[styles.debugPanel, !isCompact && styles.debugPanelWide]}>
              <Text style={styles.debugTitle}>Developer trace</Text>
              <Text selectable style={styles.debugText}>{JSON.stringify({
                layout: { mode: layoutMode, width: Math.round(windowWidth), height: Math.round(windowHeight) },
                last_request: lastDebug,
                device_location: deviceLocation,
                resolved_location: locationContext,
                location_status: locationStatus,
                runtime_capabilities: runtimeCapabilities,
                sally_tts_voice: selectedSallyVoice ? { name: selectedSallyVoice.name, language: selectedSallyVoice.language, quality: selectedSallyVoice.quality, identifier: selectedSallyVoice.identifier, enhanced_english_voices_available: sallyVoices.filter((voice) => String(voice?.quality || '').toLowerCase() === 'enhanced').length } : null,
                voicepuck: { ...voicePuckState, devices: undefined, wifi_password: undefined },
                voicepuck_sync: voicePuckSync ? { ...voicePuckSync, ticket_secret: undefined } : null,
                session_recorder: { isRecording: sessionRecorderState.isRecording, durationMillis: sessionRecorderState.durationMillis },
              }, null, 2)}</Text>
            </View>
          )}
          {activeTab === 'chat' ? chatWorkspace : sessionsWorkspace}
        </View>

        {isWide && (
          <ContextRail
            locationContext={locationContext}
            deviceLocation={deviceLocation}
            voicePuckState={voicePuckState}
            activeTab={activeTab}
            lastDebug={lastDebug}
            activeChatJobId={activeChatJobId}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

// ============================================================
// COMPONENTS
// ============================================================

function normalizeAssistantMarkup(value) {
  return String(value || '')
    .replace(/<\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*\/\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*(em|i)\s*>/gi, '*')
    .replace(/<\s*\/\s*(em|i)\s*>/gi, '*')
    .replace(/<\s*u\s*>/gi, '++')
    .replace(/<\s*\/\s*u\s*>/gi, '++')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function RichAssistantText({ value }) {
  const text = normalizeAssistantMarkup(value);
  const tokenPattern = /(\[[^\]]+\]\(https?:\/\/[^)]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*|\+\+[^+]+\+\+)/g;
  const parts = text.split(tokenPattern).filter((part) => part !== '');

  return (
    <Text selectable style={styles.assistantText}>
      {parts.map((part, index) => {
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
        if (link) {
          return (
            <Text
              key={`link-${index}`}
              style={styles.inlineLink}
              onPress={() => Linking.openURL(link[2])}
            >
              {link[1]}
            </Text>
          );
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <Text key={`bold-${index}`} style={styles.inlineBold}>{part.slice(2, -2)}</Text>;
        }
        if (part.startsWith('++') && part.endsWith('++')) {
          return <Text key={`underline-${index}`} style={styles.inlineUnderline}>{part.slice(2, -2)}</Text>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <Text key={`italic-${index}`} style={styles.inlineItalic}>{part.slice(1, -1)}</Text>;
        }
        return <Text key={`plain-${index}`}>{part}</Text>;
      })}
    </Text>
  );
}

function MessageBubble({ item, speakingMessageId, onSpeak, onStopSpeak }) {
  if (item.role === 'user') {
    return (
      <View style={styles.userBubbleWrap}>
        <View style={styles.userBubble}>
          <Text selectable style={styles.userBubbleText}>{item.text}</Text>
        </View>
      </View>
    );
  }

  if (item.role === 'system') {
    return (
      <View style={styles.systemBubble}>
        <Text selectable style={styles.systemBubbleText}>{item.text}</Text>
      </View>
    );
  }

  return (
    <View style={styles.assistantMessage}>
      <View style={styles.sallyMark}>
        <Text style={styles.sallyMarkText}>S</Text>
      </View>
      <View style={styles.assistantCopy}>
        {!!item.text && <RichAssistantText value={item.text} />}

        {Array.isArray(item.uiBlocks) && item.uiBlocks.length > 0 && (
          <View style={styles.uiBlocksWrap}>
            {item.uiBlocks.map((block, index) => (
              <UIBlockRenderer key={`${block?.type || 'block'}-${index}`} block={block} />
            ))}
          </View>
        )}

        {!item.localOnly && (
          <TouchableOpacity
            style={styles.listenButton}
            onPress={() =>
              speakingMessageId === item.id
                ? onStopSpeak?.()
                : onSpeak?.(item.speechText || item.text, item.id)
            }
          >
            <Text style={styles.listenButtonText}>
              {speakingMessageId === item.id ? '■ Stop' : '🔊 Listen'}
            </Text>
          </TouchableOpacity>
        )}

        {Array.isArray(item.sources) && item.sources.length > 0 && (
          <View style={styles.sourcesWrap}>
            <Text style={styles.sourcesLabel}>SOURCES</Text>
            {item.sources.slice(0, 5).map((source, index) => {
              const title = source?.title || source?.url || `Source ${index + 1}`;
              const url = source?.url;
              return (
                <TouchableOpacity
                  key={`${url || title}-${index}`}
                  style={styles.sourceRow}
                  disabled={!url}
                  onPress={() => url && Linking.openURL(url)}
                >
                  <Text style={styles.sourceIndex}>{index + 1}</Text>
                  <Text numberOfLines={2} style={styles.sourceTitle}>{title}</Text>
                  <Text style={styles.sourceArrow}>↗</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

function QuickPrompt({ text, onPress }) {
  return (
    <TouchableOpacity style={styles.quickPrompt} onPress={() => onPress(text)}>
      <Text style={styles.quickPromptText}>{text}</Text>
    </TouchableOpacity>
  );
}

function ProcessingStatusCard({ status, events = [], requestId }) {
  const visible = (events || [])
    .filter((event, index, list) => index === 0 || event?.message !== list[index - 1]?.message)
    .slice(-4);

  return (
    <View style={styles.processingCard}>
      <View style={styles.processingHeader}>
        <View style={styles.processingMark}><Text style={styles.processingMarkText}>S</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.processingTitle}>Sally is working</Text>
          {!!requestId && <Text style={styles.processingRequest}>{requestId}</Text>}
        </View>
      </View>
      {visible.length > 1 ? (
        <View style={styles.processingSteps}>
          {visible.map((event, index) => {
            const active = index === visible.length - 1;
            return (
              <View key={`${event?.code || 'step'}-${index}`} style={styles.processingStep}>
                {active ? <ActivityIndicator size="small" /> : <Text style={styles.processingCheck}>✓</Text>}
                <Text style={[styles.processingStepText, active && styles.processingStepTextActive]}>
                  {event?.message || status || 'Working…'}
                </Text>
              </View>
            );
          })}
        </View>
      ) : (
        <View style={styles.processingStep}>
          <ActivityIndicator size="small" />
          <Text style={styles.processingStepTextActive}>{status || visible[0]?.message || 'Working…'}</Text>
        </View>
      )}
    </View>
  );
}

function UIBlockRenderer({ block }) {
  if (!block || !Array.isArray(block.items)) return null;

  if (block.type === 'opportunity_list') return <OpportunityListBlock block={block} />;
  if (block.type === 'opportunity_summary') return <OpportunitySummaryBlock block={block} />;
  if (block.type === 'opportunity_context') return <OpportunityContextBlock block={block} />;
  if (block.type === 'event_list') return <EventListBlock block={block} />;
  if (block.type === 'task_list') return <TaskListBlock block={block} />;
  if (block.type === 'account_list') return <AccountListBlock block={block} />;
  if (block.type === 'contact_list') return <ContactListBlock block={block} />;
  if (block.type === 'nearby_account_list') return <NearbyAccountListBlock block={block} />;
  return null;
}

function OpportunityListBlock({ block }) {
  const { width } = useWindowDimensions();
  const compact = width < 680;
  const items = block.items || [];
  const total = items.reduce((sum, item) => sum + (Number(item?.amount) || 0), 0);

  if (compact) {
    return (
      <View style={styles.dataBlock}>
        <View style={styles.dataBlockHeader}>
          <View style={{ flex: 1 }}><Text style={styles.dataBlockEyebrow}>SALESFORCE</Text><Text style={styles.dataBlockTitle}>{block.title || 'Opportunities'}</Text></View>
          <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{items.length} · {formatMoney(total)}</Text></View>
        </View>
        {items.map((item, index) => (
          <View key={item?.id || index} style={styles.oppCompactCard}>
            <View style={styles.oppCompactTop}><View style={{ flex: 1 }}><Text style={styles.tablePrimary}>{item?.name || 'Unnamed opportunity'}</Text><Text style={styles.tableSecondary}>{item?.account?.name || '—'}</Text></View><Text style={styles.oppCompactAmount}>{formatMoney(item?.amount)}</Text></View>
            <View style={styles.oppCompactMetaRow}><Text style={styles.oppCompactMeta}>{item?.stage || '—'}</Text><Text style={styles.oppCompactMeta}>Close {formatDate(item?.close_date)}</Text></View>
            {!!item?.primary_product && <Text style={styles.tableTertiary}>{item.primary_product}</Text>}
            {!!item?.confidence_level && <Text style={styles.tableTertiary}>Confidence {item.confidence_level}{item?.add_to_forecast ? ` · Forecast ${item.add_to_forecast}` : ''}</Text>}
            {!!item?.primary_contact?.name && (
              <TouchableOpacity disabled={!item?.primary_contact?.phone && !item?.primary_contact?.mobile} onPress={() => dialPhone(item?.primary_contact?.mobile || item?.primary_contact?.phone)}>
                <Text style={[styles.tableTertiary, (item?.primary_contact?.phone || item?.primary_contact?.mobile) && styles.callableText]}>{item.primary_contact.name}{(item?.primary_contact?.phone || item?.primary_contact?.mobile) ? ' · Call' : ''}</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}><View><Text style={styles.dataBlockEyebrow}>SALESFORCE</Text><Text style={styles.dataBlockTitle}>{block.title || 'Opportunities'}</Text></View><View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{items.length} · {formatMoney(total)}</Text></View></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
        <View style={styles.oppTable}>
          <View style={[styles.oppTableRow, styles.oppTableHeader]}><Text style={[styles.tableHeadText, styles.colOpportunity]}>OPPORTUNITY</Text><Text style={[styles.tableHeadText, styles.colStage]}>STAGE</Text><Text style={[styles.tableHeadText, styles.colAmount]}>AMOUNT</Text><Text style={[styles.tableHeadText, styles.colClose]}>CLOSE</Text></View>
          {items.map((item, index) => (
            <View key={item?.id || index} style={styles.oppTableRow}>
              <View style={styles.colOpportunity}><Text numberOfLines={2} style={styles.tablePrimary}>{item?.name || 'Unnamed opportunity'}</Text><Text numberOfLines={1} style={styles.tableSecondary}>{item?.account?.name || '—'}</Text>{!!item?.primary_product && <Text numberOfLines={1} style={styles.tableTertiary}>{item.primary_product}</Text>}{!!item?.primary_contact?.name && <TouchableOpacity disabled={!item?.primary_contact?.phone && !item?.primary_contact?.mobile} onPress={() => dialPhone(item?.primary_contact?.mobile || item?.primary_contact?.phone)}><Text numberOfLines={1} style={[styles.tableTertiary, (item?.primary_contact?.phone || item?.primary_contact?.mobile) && styles.callableText]}>{item.primary_contact.name}{(item?.primary_contact?.phone || item?.primary_contact?.mobile) ? ' · Call' : ''}</Text></TouchableOpacity>}</View>
              <View style={styles.colStage}><Text numberOfLines={2} style={styles.tableCellText}>{item?.stage || '—'}</Text>{!!item?.confidence_level && <Text style={styles.tableTertiary}>Confidence {item.confidence_level}</Text>}{!!item?.add_to_forecast && <Text style={styles.tableTertiary}>Forecast {item.add_to_forecast}</Text>}</View>
              <Text style={[styles.tableCellStrong, styles.colAmount]}>{formatMoney(item?.amount)}</Text><Text style={[styles.tableCellText, styles.colClose]}>{formatDate(item?.close_date)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function OpportunitySummaryBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View><Text style={styles.dataBlockEyebrow}>SALESFORCE · AGGREGATE</Text><Text style={styles.dataBlockTitle}>{block.title || 'Opportunity summary'}</Text></View>
        <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{block.items?.length || 0}</Text></View>
      </View>
      {(block.items || []).map((item, index) => (
        <View key={`${item?.group || 'total'}-${index}`} style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{item?.group || 'Total'}</Text>
          <Text style={styles.summaryValue}>{item?.aggregate === 'count' ? String(item?.value ?? 0) : formatMoney(item?.value)}</Text>
        </View>
      ))}
    </View>
  );
}

function OpportunityContextBlock({ block }) {
  const item = block.items?.[0] || {};
  const opp = item.opportunity || {};
  const contact = opp.primary_contact || (opp.contacts || []).find((r) => r?.is_primary)?.contact;
  return (
    <View style={styles.dataBlock}>
      <Text style={styles.dataBlockEyebrow}>OPPORTUNITY · SALESFORCE</Text>
      <Text style={styles.contextTitle}>{opp.name || 'Opportunity'}</Text>
      <Text style={styles.contextAccount}>{opp.account?.name || '—'}</Text>
      <View style={styles.contextMetrics}>
        <View style={styles.contextMetric}><Text style={styles.contextMetricLabel}>AMOUNT</Text><Text style={styles.contextMetricValue}>{formatMoney(opp.amount)}</Text></View>
        <View style={styles.contextMetric}><Text style={styles.contextMetricLabel}>STAGE</Text><Text style={styles.contextMetricValue}>{opp.stage || '—'}</Text></View>
        <View style={styles.contextMetric}><Text style={styles.contextMetricLabel}>CLOSE</Text><Text style={styles.contextMetricValue}>{formatDate(opp.close_date)}</Text></View>
      </View>
      <View style={styles.contextInfoCard}>
        {!!opp.project_number && <Text style={styles.contextLine}>Project · {opp.project_number}</Text>}
        {!!opp.primary_product && <Text style={styles.contextLine}>Product · {opp.primary_product}</Text>}
        {!!opp.confidence_level && <Text style={styles.contextLine}>Confidence · {opp.confidence_level}</Text>}
        {!!opp.add_to_forecast && <Text style={styles.contextLine}>Add to Forecast · {opp.add_to_forecast}</Text>}
        {!!opp.next_step && <Text style={styles.contextLine}>Next step · {opp.next_step}</Text>}
      </View>
      {!!contact?.name && (
        <TouchableOpacity style={styles.contactActionCard} disabled={!contact?.phone && !contact?.mobile} onPress={() => dialPhone(contact?.mobile || contact?.phone)}>
          <View style={{ flex: 1 }}><Text style={styles.simpleDataTitle}>{contact.name}</Text><Text style={styles.simpleDataMeta}>{contact.title || 'Primary contact'}</Text></View>
          {!!(contact?.phone || contact?.mobile) && <Text style={styles.callAction}>☎ Call</Text>}
        </TouchableOpacity>
      )}
      <Text style={styles.contextActivityCount}>{item.events?.length || 0} Events · {item.tasks?.length || 0} Tasks loaded</Text>
    </View>
  );
}

function TaskListBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View><Text style={styles.dataBlockEyebrow}>SALESFORCE TASKS</Text><Text style={styles.dataBlockTitle}>{block.title || 'Tasks'}</Text></View>
        <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{block.items?.length || 0}</Text></View>
      </View>
      {(block.items || []).map((item, index) => (
        <View key={item?.id || index} style={styles.taskCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.simpleDataTitle}>{item?.subject || 'Task'}</Text>
            <Text style={styles.simpleDataMeta}>{[item?.what?.name, item?.who?.name].filter(Boolean).join(' · ') || 'No related record'}</Text>
          </View>
          <View style={styles.taskRight}><Text style={styles.taskDate}>{formatDate(item?.activity_date)}</Text><Text style={styles.simpleDataMeta}>{item?.status || '—'}</Text></View>
        </View>
      ))}
    </View>
  );
}

function EventListBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View>
          <Text style={styles.dataBlockEyebrow}>SALESFORCE EVENTS</Text>
          <Text style={styles.dataBlockTitle}>{block.title || 'Schedule'}</Text>
        </View>
        <View style={styles.dataMetricPill}>
          <Text style={styles.dataMetricText}>{block.items.length}</Text>
        </View>
      </View>

      {block.items.map((item, index) => (
        <View key={item?.id || index} style={styles.eventCard}>
          <View style={styles.eventTimeCol}>
            <Text style={styles.eventTime}>{item?.is_all_day_event ? 'ALL DAY' : formatTime(item?.start_datetime)}</Text>
            <Text style={styles.eventDate}>{formatDate(item?.activity_date || item?.start_datetime)}</Text>
          </View>
          <View style={styles.eventDivider} />
          <View style={styles.eventMain}>
            <Text style={styles.eventSubject}>{item?.subject || 'Untitled event'}</Text>
            <Text style={styles.eventMeta}>
              {[item?.who?.name, item?.what?.name].filter(Boolean).join(' · ') || 'No related record'}
            </Text>
            {!item?.is_all_day_event && (
              <Text style={styles.eventMeta}>{formatTime(item?.start_datetime)} – {formatTime(item?.end_datetime)}</Text>
            )}
            {!!item?.location && <Text style={styles.eventLocation}>{item.location}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

function AccountListBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View>
          <Text style={styles.dataBlockEyebrow}>ACCOUNTS</Text>
          <Text style={styles.dataBlockTitle}>{block.title || 'Accounts'}</Text>
        </View>
        <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{block.items.length}</Text></View>
      </View>
      {block.items.map((item, index) => (
        <View key={item?.id || index} style={styles.simpleDataCard}>
          <Text style={styles.simpleDataTitle}>{item?.name || 'Unnamed account'}</Text>
          <Text style={styles.simpleDataMeta}>{item?.industry || 'Industry not set'}</Text>
          <Text style={styles.simpleDataMeta}>{formatAddress(item?.billing_address)}</Text>
        </View>
      ))}
    </View>
  );
}

function ContactListBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View>
          <Text style={styles.dataBlockEyebrow}>CONTACTS</Text>
          <Text style={styles.dataBlockTitle}>{block.title || 'Contacts'}</Text>
        </View>
        <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{block.items.length}</Text></View>
      </View>
      {block.items.map((item, index) => (
        <View key={item?.id || index} style={styles.simpleDataCard}>
          <Text style={styles.simpleDataTitle}>{item?.name || 'Unnamed contact'}</Text>
          <Text style={styles.simpleDataMeta}>
            {[item?.title, item?.account?.name].filter(Boolean).join(' · ') || '—'}
          </Text>
          {!!(item?.mobile || item?.phone) && (
            <TouchableOpacity onPress={() => dialPhone(item?.mobile || item?.phone)}>
              <Text style={styles.callableText}>☎ {item?.mobile || item?.phone} · Call</Text>
            </TouchableOpacity>
          )}
          {!!item?.email && <Text style={styles.simpleDataMeta}>{item.email}</Text>}
        </View>
      ))}
    </View>
  );
}

function NearbyAccountListBlock({ block }) {
  return (
    <View style={styles.dataBlock}>
      <View style={styles.dataBlockHeader}>
        <View>
          <Text style={styles.dataBlockEyebrow}>NEARBY · SALESFORCE</Text>
          <Text style={styles.dataBlockTitle}>{block.title || 'Nearby accounts'}</Text>
        </View>
        <View style={styles.dataMetricPill}><Text style={styles.dataMetricText}>{block.items?.length || 0}</Text></View>
      </View>
      {(block.items || []).map((item, index) => (
        <View key={item?.account?.id || index} style={styles.nearbyCard}>
          <View style={styles.nearbyTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.simpleDataTitle}>{item?.account?.name || 'Unnamed account'}</Text>
              <Text style={styles.simpleDataMeta}>{formatAddress(item?.account?.billing_address)}</Text>
            </View>
            <View style={styles.distancePill}>
              <Text style={styles.distanceText}>{item?.distance_miles ?? '—'} mi</Text>
            </View>
          </View>
          <Text style={styles.nearbyPipeline}>{formatMoney(item?.open_pipeline)} open pipeline</Text>
          {!!item?.top_opportunity && (
            <Text style={styles.simpleDataMeta}>
              {item.top_opportunity.name} · {item.top_opportunity.stage || '—'}
            </Text>
          )}
          {!!item?.contacts?.[0]?.name && (
            <TouchableOpacity disabled={!item?.contacts?.[0]?.phone} onPress={() => dialPhone(item?.contacts?.[0]?.phone)}>
              <Text style={[styles.simpleDataMeta, item?.contacts?.[0]?.phone && styles.callableText]}>
                Contact · {item.contacts[0].name}{item.contacts[0].title ? ` · ${item.contacts[0].title}` : ''}{item?.contacts?.[0]?.phone ? ' · Call' : ''}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

function ContextRail({ locationContext, deviceLocation, voicePuckState, activeTab, lastDebug, activeChatJobId }) {
  const locationLabel = locationContext?.effective?.label || locationDisplayLabel(locationContext?.effective) || locationDisplayLabel(deviceLocation) || 'Unavailable';
  return (
    <View style={styles.contextRail}>
      <Text style={styles.contextEyebrow}>CONTEXT</Text>
      <Text style={styles.contextTitle}>{activeTab === 'chat' ? 'Sally workspace' : 'Session workspace'}</Text>
      <View style={styles.contextCard}><Text style={styles.contextLabel}>LOCATION</Text><Text style={styles.contextValue}>{locationContext?.mode === 'demo' ? `Demo · ${locationLabel}` : locationLabel}</Text></View>
      <View style={styles.contextCard}><Text style={styles.contextLabel}>VOICEPUCK</Text><Text style={styles.contextValue}>{voicePuckState?.connected ? (voicePuckState?.device_name || voicePuckState?.device_id || 'Connected') : 'Not connected'}</Text><Text style={styles.contextMeta}>{voicePuckState?.connected ? `${voicePuckState?.state || 'idle'}${voicePuckState?.wifi_connected ? ' · Wi-Fi ready' : ' · Wi-Fi offline'}` : 'Use Sessions to connect'}</Text>{!!voicePuckState?.pending_sessions?.length && <Text style={styles.contextMeta}>{voicePuckState.pending_sessions.length} pending Session(s)</Text>}</View>
      <View style={styles.contextCard}><Text style={styles.contextLabel}>LAST ROUTE</Text><Text style={styles.contextValue}>{lastDebug?.route?.route || lastDebug?.route || '—'}</Text>{!!activeChatJobId && <Text style={styles.contextMeta}>Job {activeChatJobId}</Text>}</View>
    </View>
  );
}

function SessionsWorkspace({
  sessions,
  sessionsLoading,
  localSession,
  recorderState,
  selectedSession,
  transcript,
  linkOptions,
  busy,
  sessionSource,
  onSelectSource,
  voicePuckState,
  voicePuckDevices,
  voicePuckScanState,
  voicePuckError,
  voicePuckWifiSsid,
  voicePuckWifiPassword,
  voicePuckWifiMessage,
  voicePuckSync,
  onWifiSsid,
  onWifiPassword,
  onStart,
  onStop,
  onRetryUpload,
  onRefresh,
  onOpenSession,
  onCloseSession,
  onLoadTranscript,
  onPlayAudio,
  onRetryProcessing,
  onLoadLinkOptions,
  onLinkOpportunity,
  onDeleteSession,
  onScanVoicePuck,
  onConnectVoicePuck,
  onDisconnectVoicePuck,
  onProvisionVoicePuckWifi,
  onSyncVoicePuck,
  locationContext,
  recordingAllowed = true,
  voicePuckAllowed = true,
  deleteAllowed = true,
  layoutMode = 'compact',
}) {
  const [voicePuckExpanded, setVoicePuckExpanded] = useState(false);

  useEffect(() => {
    // Keep the hardware card quiet by default. Open it automatically only when
    // the user actually needs to intervene.
    if (
      voicePuckError ||
      voicePuckScanState === 'error' ||
      voicePuckScanState === 'none_found'
    ) {
      setVoicePuckExpanded(true);
    }
  }, [voicePuckError, voicePuckScanState]);

  if (selectedSession) {
    return (
      <SessionDetail
        session={selectedSession}
        transcript={transcript}
        linkOptions={linkOptions}
        busy={busy}
        onBack={onCloseSession}
        onLoadTranscript={onLoadTranscript}
        onPlayAudio={onPlayAudio}
        onRetryProcessing={onRetryProcessing}
        onLoadLinkOptions={onLoadLinkOptions}
        onLinkOpportunity={onLinkOpportunity}
      />
    );
  }

  const voiceRecording = localSession?.source === 'voicepuck' && localSession?.status === 'recording';
  const iphoneRecording = recorderState?.isRecording || (localSession?.source === 'iphone' && localSession?.status === 'recording');
  const recording = voiceRecording || iphoneRecording;
  const currentDuration = voiceRecording
    ? voicePuckState?.recording_duration_ms || (Date.now() - new Date(localSession?.started_at || Date.now()).getTime())
    : iphoneRecording
      ? recorderState?.durationMillis || (Date.now() - new Date(localSession?.started_at || Date.now()).getTime())
      : localSession?.duration_ms || 0;
  const voiceConnected = Boolean(voicePuckState?.connected);
  const voiceSupported = voicePuckAllowed && voicePuckState?.supported !== false;
  const sourceReady = sessionSource === 'voicepuck' ? (voiceSupported && voiceConnected) : recordingAllowed;
  const pendingSessions = Array.isArray(voicePuckState?.pending_sessions) ? voicePuckState.pending_sessions : [];
  const wide = layoutMode !== 'compact';

  return (
    <ScrollView style={styles.sessionsScreen} contentContainerStyle={[styles.sessionsContent, wide && styles.sessionsContentWide]}>
      {recording ? (
        <View style={styles.recordingHero}>
          <Text style={styles.recordingEyebrow}>{voiceRecording ? 'VOICEPUCK SESSION' : 'IPHONE SESSION'}</Text>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingTimer}>{formatDuration(currentDuration)}</Text>
          <Text style={styles.recordingTitle}>Recording</Text>
          <Text style={styles.recordingBody}>
            {voiceRecording
              ? 'VoicePuck is writing audio to microSD first. If the phone disconnects, recording continues on the Puck.'
              : 'You can lock your iPhone. The Session recording is configured to continue in the background.'}
          </Text>
          <TouchableOpacity style={styles.stopSessionButton} disabled={busy} onPress={onStop}>
            <Text style={styles.stopSessionButtonText}>{busy ? 'Stopping…' : '■  Stop Session'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.startSessionCard}>
          <View style={styles.sessionSectionHeader}>
            <View><Text style={styles.sessionEyebrow}>RECORDING SOURCE</Text><Text style={styles.sessionHeading}>Start a Session</Text></View>
            <Text style={styles.sessionLocationSmall}>{locationContext?.mode === 'demo' ? `📍 Demo · ${locationContext?.effective?.label || 'CRM territory'}` : '📍 Device location'}</Text>
          </View>

          <View style={[styles.sourceGrid, wide && styles.sourceGridWide]}>
            <TouchableOpacity
              style={[styles.sourceCard, wide && styles.sourceCardWide, sessionSource === 'iphone' && styles.sourceCardSelected]}
              disabled={!recordingAllowed}
              onPress={() => onSelectSource?.('iphone')}
            >
              <View style={sessionSource === 'iphone' ? styles.sourceRadioSelected : styles.sourceRadio}>{sessionSource === 'iphone' && <View style={styles.sourceRadioInner} />}</View>
              <View style={{ flex: 1 }}><Text style={styles.sourceTitle}>iPhone</Text><Text style={styles.sourceMeta}>{recordingAllowed ? 'Local-first M4A · background capable' : 'Disabled by administrator'}</Text></View>
              <Text style={recordingAllowed ? styles.readyPill : styles.offlinePill}>{recordingAllowed ? 'Ready' : 'Disabled'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sourceCard, wide && styles.sourceCardWide, sessionSource === 'voicepuck' && styles.sourceCardSelected]}
              disabled={!voiceConnected}
              onPress={() => voiceConnected && onSelectSource?.('voicepuck')}
            >
              <View style={sessionSource === 'voicepuck' ? styles.sourceRadioSelected : styles.sourceRadio}>{sessionSource === 'voicepuck' && <View style={styles.sourceRadioInner} />}</View>
              <View style={{ flex: 1 }}><Text style={styles.sourceTitle}>VoicePuck</Text><Text style={styles.sourceMeta}>{!voiceSupported ? 'Use iOS/Android companion app for BLE' : voiceConnected ? `${voicePuckState?.device_name || voicePuckState?.device_id || 'Connected'} · ${voicePuckState?.state || 'idle'}` : 'Offline recording works from the physical BOOT button'}</Text></View>
              <Text style={voiceConnected ? styles.readyPill : styles.offlinePill}>{voiceConnected ? 'Connected' : 'Not connected'}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.voicePuckPanel}>
            <View style={styles.voicePuckPanelHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sessionEyebrow}>VOICEPUCK V4.2A</Text>
                <Text style={styles.voicePuckPanelTitle}>
                  {voiceConnected
                    ? (voicePuckState?.device_name || voicePuckState?.device_id || 'VoicePuck')
                    : voicePuckState?.reconnecting
                      ? 'Reconnecting automatically…'
                      : 'VoicePuck'}
                </Text>
                <Text style={styles.voicePuckCompactMeta}>
                  {voiceConnected
                    ? `${String(voicePuckState?.state || 'idle')} · ${voicePuckState?.wifi_connected ? 'Wi-Fi ready' : 'Wi-Fi offline'}${(voicePuckState?.pending_count || pendingSessions.length) ? ` · ${voicePuckState?.pending_count || pendingSessions.length} pending` : ''}`
                    : voicePuckState?.reconnecting
                      ? 'Sally will reconnect as soon as the Puck is available.'
                      : 'Offline button recording still works.'}
                </Text>
              </View>

              <TouchableOpacity
                style={styles.voicePuckDetailsToggle}
                onPress={() => setVoicePuckExpanded((value) => !value)}
              >
                <Text style={styles.voicePuckDetailsToggleText}>
                  {voicePuckExpanded ? 'Hide' : 'Details'}
                </Text>
                <Text style={styles.voicePuckChevron}>{voicePuckExpanded ? '⌃' : '⌄'}</Text>
              </TouchableOpacity>
            </View>

            {/* Keep the normal state compact. Pending audio auto-syncs, while a
                manual Sync action remains available as a fallback. */}
            {voiceConnected && !!pendingSessions.length && !voicePuckExpanded && (
              <View style={styles.voicePuckCompactPending}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailLineStrong}>
                    {voicePuckState?.pending_count || pendingSessions.length} Session{(voicePuckState?.pending_count || pendingSessions.length) === 1 ? '' : 's'} waiting safely
                  </Text>
                  <Text style={styles.detailSubline}>
                    Auto-sync is on. Audio stays on the Puck until server verification.
                  </Text>
                </View>
                <TouchableOpacity
                  disabled={busy || !voicePuckState?.wifi_connected}
                  onPress={() => onSyncVoicePuck(pendingSessions[0])}
                >
                  <Text style={styles.refreshText}>Sync now</Text>
                </TouchableOpacity>
              </View>
            )}

            {voicePuckExpanded && (
              <>
                {!voiceSupported ? (
                  <Text style={styles.detailSubline}>Direct BLE is intentionally disabled on web. VoicePuck Sessions sync through the iOS/Android companion app and then appear here.</Text>
                ) : !voiceConnected ? (
                  <>
                    <TouchableOpacity style={styles.secondaryAction} disabled={busy || voicePuckScanState === 'scanning'} onPress={onScanVoicePuck}>
                      <Text style={styles.secondaryActionText}>
                        {voicePuckScanState === 'scanning'
                          ? 'Scanning…'
                          : voicePuckState?.reconnecting
                            ? 'Scan now'
                            : 'Find VoicePuck'}
                      </Text>
                    </TouchableOpacity>
                    {voicePuckScanState === 'none_found' && <Text style={styles.detailSubline}>No VoicePuck advertised nearby. Sally will continue trying automatically while Bluetooth is available.</Text>}
                    {(voicePuckDevices || []).map((device) => (
                      <View key={device.id} style={styles.voicePuckDeviceRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailLineStrong}>{device.name || 'VoicePuck'}</Text>
                          <Text style={styles.detailSubline}>{device.id}{device.rssi != null ? ` · ${device.rssi} dBm` : ''}</Text>
                        </View>
                        <TouchableOpacity style={styles.miniAction} disabled={busy} onPress={() => onConnectVoicePuck(device.id)}>
                          <Text style={styles.miniActionText}>Connect</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                ) : (
                  <>
                    <View style={styles.voicePuckStatsRow}>
                      <VoicePuckStat label="STATE" value={String(voicePuckState?.state || 'idle')} />
                      <VoicePuckStat label="BATTERY" value={voicePuckState?.battery_percent == null ? '—' : `${Math.round(voicePuckState.battery_percent)}%`} />
                      <VoicePuckStat label="STORAGE" value={voicePuckState?.storage_free_mb == null ? '—' : `${Math.round(voicePuckState.storage_free_mb)} MB`} />
                    </View>

                    <Text style={styles.detailSubline}>
                      Firmware · {voicePuckState?.firmware_version || 'unknown'} · Wi-Fi · {voicePuckState?.wifi_connected ? (voicePuckState?.wifi_ssid || 'connected') : 'not connected'}
                    </Text>

                    <View style={styles.wifiBox}>
                      <Text style={styles.detailLineStrong}>Wi-Fi for Session sync</Text>
                      <Text style={styles.detailSubline}>
                        {voicePuckState?.wifi_connected
                          ? `Connected${voicePuckState?.wifi_ssid ? ` · ${voicePuckState.wifi_ssid}` : ''}. Enter new credentials below only if you want to change networks.`
                          : 'Sally sends credentials over BLE. VoicePuck now tests the connection before saving them.'}
                      </Text>
                      <TextInput style={styles.wifiInput} value={voicePuckWifiSsid} onChangeText={onWifiSsid} placeholder="Wi-Fi SSID" autoCapitalize="none" />
                      <TextInput style={styles.wifiInput} value={voicePuckWifiPassword} onChangeText={onWifiPassword} placeholder="Wi-Fi password" secureTextEntry autoCapitalize="none" />
                      <TouchableOpacity style={styles.secondaryAction} disabled={busy || !voicePuckWifiSsid?.trim()} onPress={onProvisionVoicePuckWifi}>
                        <Text style={styles.secondaryActionText}>{busy && voicePuckWifiMessage?.startsWith('Checking') ? 'Checking Wi-Fi…' : 'Check & save Wi-Fi'}</Text>
                      </TouchableOpacity>
                      {!!voicePuckWifiMessage && (
                        <Text style={voicePuckWifiMessage.startsWith('Wi-Fi verified') ? styles.detailSubline : styles.errorInline}>
                          {voicePuckWifiMessage}
                        </Text>
                      )}
                    </View>

                    {!!pendingSessions.length && (
                      <View style={styles.pendingBox}>
                        <Text style={styles.detailLineStrong}>
                          {pendingSessions.length} Session{pendingSessions.length === 1 ? '' : 's'} waiting on the Puck
                        </Text>
                        <Text style={styles.detailSubline}>Sally auto-syncs when BLE + Puck Wi-Fi are available. Sync remains here as a manual fallback.</Text>
                        {pendingSessions.map((sid) => (
                          <View key={sid} style={styles.pendingRow}>
                            <Text numberOfLines={1} style={styles.pendingId}>{sid}</Text>
                            <TouchableOpacity disabled={busy || !voicePuckState?.wifi_connected} onPress={() => onSyncVoicePuck(sid)}>
                              <Text style={styles.refreshText}>Sync</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                      </View>
                    )}

                    <TouchableOpacity onPress={onDisconnectVoicePuck} style={styles.voicePuckDisconnect}>
                      <Text style={styles.voicePuckDisconnectText}>Disconnect this VoicePuck</Text>
                    </TouchableOpacity>
                  </>
                )}

                {!!voicePuckSync && (
                  <Text style={styles.detailSubline}>
                    Sync · {voicePuckSync.state}
                    {voicePuckSync.total_chunks ? ` · ${voicePuckSync.received_chunks || 0}/${voicePuckSync.total_chunks} chunks` : ''}
                    {voicePuckSync.error ? ` · ${voicePuckSync.error}` : voicePuckSync.note ? ` · ${voicePuckSync.note}` : ''}
                  </Text>
                )}
              </>
            )}

            {!!voicePuckError && <Text style={styles.errorInline}>{voicePuckError}</Text>}
          </View>

          <TouchableOpacity style={[styles.startSessionButton, !sourceReady && styles.startSessionButtonDisabled]} disabled={busy || !sourceReady} onPress={onStart}>
            <Text style={styles.startSessionButtonText}>{!sourceReady ? (sessionSource === 'voicepuck' ? 'Connect VoicePuck first' : 'Session recording disabled') : busy ? 'Preparing…' : `●  Start on ${sessionSource === 'voicepuck' ? 'VoicePuck' : 'iPhone'}`}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!localSession && !recording && (
        <View style={styles.localSessionCard}>
          <Text style={styles.sessionEyebrow}>{localSession?.source === 'voicepuck' ? 'VOICEPUCK' : 'LOCAL RECORDING'}</Text>
          <Text style={styles.localSessionTitle}>{localSession?.status === 'pending_sync' ? 'Waiting to sync safely' : sessionStatusLabel(localSession.status)}</Text>
          {!!localSession.duration_ms && <Text style={styles.sourceMeta}>{formatDuration(localSession.duration_ms)}</Text>}
          {!!localSession.error && <Text style={styles.errorInline}>{localSession.error}</Text>}
          {localSession.status === 'upload_failed' && <TouchableOpacity style={styles.secondaryAction} disabled={busy} onPress={onRetryUpload}><Text style={styles.secondaryActionText}>{busy ? 'Retrying…' : 'Retry upload'}</Text></TouchableOpacity>}
        </View>
      )}

      <View style={styles.sessionListHeader}><View><Text style={styles.sessionEyebrow}>HISTORY</Text><Text style={styles.sessionHeading}>Previous Sessions</Text></View><TouchableOpacity onPress={onRefresh}><Text style={styles.refreshText}>Refresh</Text></TouchableOpacity></View>
      {sessionsLoading && <ActivityIndicator style={{ marginVertical: 22 }} />}
      {!sessionsLoading && !sessions.length && <Text style={styles.emptySessions}>No uploaded Sessions yet. Your first completed recording will appear here.</Text>}
      {sessions.map((session) => (
        <View key={session.session_id} style={styles.sessionRowCard}>
          <TouchableOpacity style={styles.sessionRowOpen} onPress={() => onOpenSession(session)}>
            <View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.sessionRowTitle}>{session.title || 'Sales Session'}</Text><Text style={styles.sessionRowMeta}>{session?.source === 'voicepuck' ? 'VoicePuck · ' : ''}{formatDuration(session.duration_ms)} · {sessionStatusLabel(session.status)}</Text>{!!session.linked_opportunity?.name && <Text numberOfLines={1} style={styles.linkedMeta}>↗ {session.linked_opportunity.name}</Text>}</View><Text style={styles.rowArrow}>›</Text>
          </TouchableOpacity>
          {deleteAllowed && !['uploaded', 'transcribing', 'analyzing'].includes(session?.status) && <TouchableOpacity style={styles.sessionDeleteButton} disabled={busy} onPress={() => onDeleteSession?.(session)}><Text style={styles.sessionDeleteButtonText}>Delete</Text></TouchableOpacity>}
        </View>
      ))}
    </ScrollView>
  );
}

function VoicePuckStat({ label, value }) {
  return <View style={styles.voicePuckStat}><Text style={styles.voicePuckStatLabel}>{label}</Text><Text numberOfLines={1} style={styles.voicePuckStatValue}>{value}</Text></View>;
}

function SessionDetail({
  session,
  transcript,
  linkOptions,
  busy,
  onBack,
  onLoadTranscript,
  onPlayAudio,
  onRetryProcessing,
  onLoadLinkOptions,
  onLinkOpportunity,
}) {
  const summary = session?.summary || {};
  const actual = session?.actual_location;
  const effective = session?.effective_location;

  return (
    <ScrollView style={styles.sessionsScreen} contentContainerStyle={styles.sessionDetailContent}>
      <TouchableOpacity onPress={onBack}><Text style={styles.backLink}>‹ Sessions</Text></TouchableOpacity>
      <Text style={styles.sessionDetailTitle}>{session?.title || 'Sales Session'}</Text>
      <Text style={styles.sessionDetailMeta}>
        {formatDateTime(session?.started_at)} · {formatDuration(session?.duration_ms)} · {sessionStatusLabel(session?.status)}
      </Text>

      {session?.status === 'error' && (
        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>Processing stopped</Text>
          <Text style={styles.warningText}>{session.processing_error || 'The processing job failed.'}</Text>
          <TouchableOpacity style={styles.secondaryAction} disabled={busy} onPress={() => onRetryProcessing(session.session_id)}>
            <Text style={styles.secondaryActionText}>Retry processing</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.detailCard}>
        <Text style={styles.detailCardEyebrow}>RECORDING</Text>
        <Text style={styles.detailLine}>Source · {session?.source === 'iphone' ? 'iPhone' : session?.source === 'voicepuck' ? 'VoicePuck' : session?.source || 'Unknown'}</Text>
        <Text style={styles.detailLine}>Original audio · {session?.has_audio ? formatBytes(session?.audio_bytes) : 'Unavailable'}</Text>
        <View style={styles.detailActionRow}>
          {session?.has_audio && (
            <TouchableOpacity style={styles.miniAction} onPress={() => onPlayAudio(session.session_id)}>
              <Text style={styles.miniActionText}>▶ Play recording</Text>
            </TouchableOpacity>
          )}
        </View>
        {session?.source === 'voicepuck' && (
          <View style={styles.voicePuckDetailRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.detailLineStrong}>VoicePuck capture</Text>
              <Text style={styles.detailSubline}>Device · {session?.voicepuck?.device_id || 'Unknown'} · Firmware · {session?.voicepuck?.firmware_version || 'Unknown'}</Text>
              <Text style={styles.detailSubline}>The Puck deleted its local copy only after Sally verified the uploaded Session and returned the final acknowledgement.</Text>
            </View>
          </View>
        )}
      </View>

      <View style={styles.detailCard}>
        <Text style={styles.detailCardEyebrow}>LOCATION</Text>
        <Text style={styles.detailLineStrong}>{locationDisplayLabel(actual) || 'No location captured'}</Text>
        {!!effective && (
          <Text style={styles.detailSubline}>
            CRM geography · {effective?.label || locationDisplayLabel(effective) || 'Same as device'}
          </Text>
        )}
      </View>

      <View style={styles.detailCard}>
        <Text style={styles.detailCardEyebrow}>LINKED OPPORTUNITY</Text>
        {session?.linked_opportunity ? (
          <>
            <Text style={styles.detailLineStrong}>{session.linked_opportunity.name}</Text>
            <Text style={styles.detailSubline}>
              {session.linked_opportunity.confidence != null ? `${Math.round(session.linked_opportunity.confidence * 100)}% match` : 'Manually linked'}
            </Text>
            <TouchableOpacity onPress={onLoadLinkOptions}><Text style={styles.refreshText}>Change link</Text></TouchableOpacity>
          </>
        ) : session?.suggested_opportunity ? (
          <>
            <Text style={styles.detailLineStrong}>Suggested · {session.suggested_opportunity.name}</Text>
            <Text style={styles.detailSubline}>{Math.round((session.suggested_opportunity.confidence || 0) * 100)}% · {session.suggested_opportunity.reason || 'Possible transcript match'}</Text>
            <View style={styles.detailActionRow}>
              <TouchableOpacity style={styles.miniAction} onPress={() => onLinkOpportunity(session.session_id, session.suggested_opportunity.id)}>
                <Text style={styles.miniActionText}>Link suggestion</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onLoadLinkOptions}><Text style={styles.refreshText}>Choose another</Text></TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.detailSubline}>No Salesforce Opportunity linked.</Text>
            <TouchableOpacity onPress={onLoadLinkOptions}><Text style={styles.refreshText}>Link Opportunity</Text></TouchableOpacity>
          </>
        )}

        {!!linkOptions.length && (
          <View style={styles.linkOptionsWrap}>
            {linkOptions.slice(0, 20).map((opp) => (
              <TouchableOpacity key={opp.id} style={styles.linkOption} onPress={() => onLinkOpportunity(session.session_id, opp.id)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkOptionTitle}>{opp.name}</Text>
                  <Text style={styles.detailSubline}>{opp.account || '—'} · {formatMoney(opp.amount)}</Text>
                </View>
                <Text style={styles.rowArrow}>›</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => onLinkOpportunity(session.session_id, null)}>
              <Text style={styles.unlinkText}>Remove link</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {!!summary?.summary && (
        <View style={styles.detailCard}>
          <Text style={styles.detailCardEyebrow}>SUMMARY</Text>
          <Text style={styles.summaryBody}>{summary.summary}</Text>
        </View>
      )}

      <SessionArraySection title="Key points" items={summary?.key_points} />
      <SessionArraySection title="Customer needs" items={summary?.customer_needs} />
      <SessionArraySection title="Products discussed" items={summary?.products_discussed} />
      <SessionArraySection title="Competitors" items={summary?.competitors} />
      <SessionArraySection title="Objections / risks" items={[...(summary?.objections || []), ...(summary?.risks || [])]} />
      <SessionArraySection title="Decisions" items={summary?.decisions} />
      <SessionArraySection title="Rep commitments" items={summary?.rep_commitments} />
      <SessionArraySection title="Customer commitments" items={summary?.customer_commitments} />
      <SessionArraySection title="Follow ups" items={summary?.follow_ups} />

      <View style={styles.detailCard}>
        <View style={styles.sessionSectionHeader}>
          <Text style={styles.detailCardEyebrow}>TRANSCRIPT</Text>
          {!transcript && session?.has_transcript && (
            <TouchableOpacity onPress={() => onLoadTranscript(session.session_id)}><Text style={styles.refreshText}>Load</Text></TouchableOpacity>
          )}
        </View>
        {!session?.has_transcript && <Text style={styles.detailSubline}>Transcript is not ready yet.</Text>}
        {!!transcript?.error && <Text style={styles.errorInline}>{transcript.error}</Text>}
        {(transcript?.segments || []).map((segment, index) => (
          <View key={segment?.id || index} style={styles.transcriptRow}>
            <Text style={styles.transcriptSpeaker}>{segment?.speaker || 'Speaker'}</Text>
            <Text style={styles.transcriptTime}>{formatDuration((segment?.start || 0) * 1000)}</Text>
            <Text selectable style={styles.transcriptText}>{segment?.text || ''}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function SessionArraySection({ title, items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <View style={styles.detailCard}>
      <Text style={styles.detailCardEyebrow}>{String(title || '').toUpperCase()}</Text>
      {items.map((item, index) => (
        <View key={`${title}-${index}`} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{typeof item === 'string' ? item : JSON.stringify(item)}</Text>
        </View>
      ))}
    </View>
  );
}

function EventCreateReview({ item }) {
  const fields = item.fields || {};
  return (
    <View style={styles.eventReviewCard}>
      <Text style={styles.changeRecord}>{item.recordName}</Text>
      <Text style={styles.eventReviewLine}>
        {fields.IsAllDayEvent
          ? `All day · ${formatDate(fields.ActivityDate)}`
          : `${formatDateTime(fields.StartDateTime)} → ${formatTime(fields.EndDateTime)}`}
      </Text>
      {!!item.who?.name && <Text style={styles.eventReviewLine}>Contact · {item.who.name}</Text>}
      {!!item.what?.name && <Text style={styles.eventReviewLine}>{item.what.type || 'Related'} · {item.what.name}</Text>}
      {!!fields.Location && <Text style={styles.eventReviewLine}>Location · {fields.Location}</Text>}
      {!!fields.Description && <Text numberOfLines={4} style={styles.eventReviewDescription}>{fields.Description}</Text>}
    </View>
  );
}

function OpportunityCreateReview({ item }) {
  const fields = item.fields || {};
  return (
    <View style={styles.eventReviewCard}>
      <Text style={styles.changeRecord}>{item.recordName}</Text>
      {!!item.account?.name && <Text style={styles.eventReviewLine}>Account · {item.account.name}</Text>}
      <Text style={styles.eventReviewLine}>Stage · {fields.StageName || '—'} · Close · {formatDate(fields.CloseDate)}</Text>
      {fields.Amount != null && <Text style={styles.eventReviewLine}>Amount · {formatMoney(fields.Amount)}</Text>}
      {!!fields.Primary_Product__c && <Text style={styles.eventReviewLine}>Product · {fields.Primary_Product__c}</Text>}
      {!!fields.Confidence_Level__c && <Text style={styles.eventReviewLine}>Confidence · {fields.Confidence_Level__c}</Text>}
      {!!fields.Add_to_Forecast__c && <Text style={styles.eventReviewLine}>Forecast · {fields.Add_to_Forecast__c}</Text>}
      {!!item.primaryContact?.name && (
        <Text style={styles.eventReviewLine}>Primary contact · {item.primaryContact.name}{item.contactRole ? ` · ${item.contactRole}` : ''}</Text>
      )}
      <Text style={styles.eventReviewDescription}>Salesforce will generate the SFDC project number, then Sally will append it to the end of the Opportunity name.</Text>
    </View>
  );
}

function TaskCreateReview({ item }) {
  const fields = item.fields || {};
  return (
    <View style={styles.eventReviewCard}>
      <Text style={styles.changeRecord}>{item.recordName}</Text>
      {!!fields.ActivityDate && <Text style={styles.eventReviewLine}>Due · {formatDate(fields.ActivityDate)}</Text>}
      <Text style={styles.eventReviewLine}>Status · {fields.Status || 'Not Started'} · Priority · {fields.Priority || 'Normal'}</Text>
      {!!item.who?.name && <Text style={styles.eventReviewLine}>Contact · {item.who.name}</Text>}
      {!!item.what?.name && <Text style={styles.eventReviewLine}>{item.what.type || 'Related'} · {item.what.name}</Text>}
      {!!fields.Description && <Text numberOfLines={4} style={styles.eventReviewDescription}>{fields.Description}</Text>}
    </View>
  );
}

function ConfirmationCard({ changes, confirming, onConfirm, onCancel }) {
  const normalized = changes.map((change, index) => normaliseChange(change, index));
  const createKinds = new Set(['create_event', 'create_opportunity', 'create_task']);
  const onlyCreates = normalized.length > 0 && normalized.every((item) => createKinds.has(item.kind));
  const singleCreateKind = normalized.length === 1 && createKinds.has(normalized[0]?.kind) ? normalized[0].kind : null;

  return (
    <View style={styles.confirmCard}>
      <View style={styles.confirmHeader}>
        <View>
          <Text style={styles.confirmEyebrow}>SALESFORCE WRITE</Text>
          <Text style={styles.confirmTitle}>{singleCreateKind === 'create_opportunity' ? 'Review opportunity' : singleCreateKind === 'create_task' ? 'Review task' : singleCreateKind === 'create_event' ? 'Review event' : 'Review changes'}</Text>
        </View>
        <View style={styles.pendingPill}>
          <Text style={styles.pendingPillText}>Pending</Text>
        </View>
      </View>

      {normalized.length === 0 ? (
        <Text style={styles.confirmBody}>
          Sally prepared a Salesforce action. Confirm only if the details are correct.
        </Text>
      ) : (
        normalized.map((item, index) => {
          if (item.kind === 'create_event') return <EventCreateReview key={`create-event-${index}`} item={item} />;
          if (item.kind === 'create_opportunity') return <OpportunityCreateReview key={`create-opportunity-${index}`} item={item} />;
          if (item.kind === 'create_task') return <TaskCreateReview key={`create-task-${index}`} item={item} />;

          return (
            <View key={`${item.recordName}-${item.field}-${index}`} style={styles.changeBlock}>
              <Text style={styles.changeRecord}>{item.recordName}</Text>
              <Text style={styles.changeField}>
                {item.kind === 'update_event' ? 'Event · ' : item.kind === 'update_task' ? 'Task · ' : ''}{humanizeFieldName(item.field)}
              </Text>
              <View style={styles.changeValuesRow}>
                <View style={styles.changeValueCol}>
                  <Text style={styles.changeLabel}>CURRENT</Text>
                  <Text selectable style={styles.changeOld}>{displayChangeValue(item.field, item.oldValue)}</Text>
                </View>
                <Text style={styles.arrow}>→</Text>
                <View style={styles.changeValueCol}>
                  <Text style={styles.changeLabel}>NEW</Text>
                  <Text selectable style={styles.changeNew}>{displayChangeValue(item.field, item.newValue)}</Text>
                </View>
              </View>
            </View>
          );
        })
      )}

      <View style={styles.confirmActions}>
        <TouchableOpacity style={styles.cancelButton} disabled={confirming} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.confirmButton} disabled={confirming} onPress={onConfirm}>
          {confirming ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmButtonText}>{singleCreateKind === 'create_opportunity' ? 'Create opportunity' : singleCreateKind === 'create_task' ? 'Create task' : singleCreateKind === 'create_event' ? 'Create event' : onlyCreates ? 'Create' : 'Confirm changes'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F7F7F4',
  },

  authScreen: {
    flex: 1,
    backgroundColor: '#F6F6F2',
  },
  authWrap: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 70,
    paddingBottom: 22,
  },
  brand: {
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '700',
    letterSpacing: -1.8,
    color: '#151515',
  },
  authTagline: {
    marginTop: 6,
    fontSize: 18,
    color: '#66645F',
  },
  authCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    minHeight: 220,
    justifyContent: 'center',
  },
  authTitle: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#171717',
  },
  authBody: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
    color: '#6B6A66',
  },
  primaryButton: {
    marginTop: 24,
    minHeight: 54,
    borderRadius: 15,
    backgroundColor: '#171717',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
  },
  disabledButton: {
    opacity: 0.4,
  },
  authLoadingText: {
    textAlign: 'center',
    marginTop: 16,
    color: '#66645F',
  },
  authErrorBox: {
    marginTop: 18,
    borderRadius: 14,
    backgroundColor: '#FFF1F1',
    padding: 14,
  },
  authErrorTitle: {
    fontWeight: '700',
    color: '#8D2222',
  },
  authErrorText: {
    marginTop: 6,
    color: '#7A3333',
    fontSize: 12,
  },
  retryText: {
    marginTop: 10,
    fontWeight: '700',
  },
  redirectDebug: {
    fontSize: 10,
    textAlign: 'center',
    color: '#AAA8A1',
  },

  header: {
    minHeight: 70,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#DAD9D4',
    backgroundColor: '#F7F7F4',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerBrand: {
    fontSize: 23,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: '#161616',
  },
  connectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  connectedDot: {
    width: 7,
    height: 7,
    borderRadius: 99,
    backgroundColor: '#3C9B58',
    marginRight: 6,
  },
  connectedText: {
    fontSize: 12,
    color: '#74716A',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  devButton: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#D8D6CF',
  },
  devButtonText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#76736C',
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#191919',
  },
  avatarText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  debugPanel: {
    maxHeight: 180,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#EFEFEA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#D7D5CF',
  },
  debugTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    color: '#55524C',
  },
  debugText: {
    marginTop: 6,
    fontSize: 10,
    lineHeight: 14,
    color: '#68655F',
  },

  messageList: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
  },
  userBubbleWrap: {
    alignItems: 'flex-end',
    marginBottom: 18,
  },
  userBubble: {
    maxWidth: '84%',
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 18,
    borderBottomRightRadius: 5,
    backgroundColor: '#202020',
  },
  userBubbleText: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
  },
  assistantMessage: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 22,
    paddingRight: 10,
  },
  sallyMark: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: '#E7E6DF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 1,
  },
  sallyMarkText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#373630',
  },
  assistantCopy: {
    flex: 1,
    paddingTop: 2,
  },
  assistantText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#22211F',
  },
  inlineBold: { fontWeight: '700' },
  inlineItalic: { fontStyle: 'italic' },
  inlineUnderline: { textDecorationLine: 'underline' },
  inlineLink: {
    textDecorationLine: 'underline',
    fontWeight: '600',
  },
  uiBlocksWrap: {
    marginTop: 13,
    gap: 12,
  },
  dataBlock: {
    borderWidth: 1,
    borderColor: '#DEDDD7',
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  dataBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E6E4DE',
  },
  dataBlockEyebrow: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    color: '#98958D',
  },
  dataBlockTitle: {
    marginTop: 2,
    fontSize: 17,
    fontWeight: '700',
    color: '#22211F',
  },
  dataMetricPill: {
    backgroundColor: '#EFEEE9',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  dataMetricText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#5F5C55',
  },
  tableScroll: {
    maxWidth: '100%',
  },
  oppTable: {
    width: 700,
  },
  oppTableHeader: {
    backgroundColor: '#F5F4F0',
  },
  oppTableRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E9E7E2',
  },
  tableHeadText: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
    color: '#8B887F',
  },
  tablePrimary: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    color: '#262521',
    paddingRight: 10,
  },
  tableSecondary: {
    marginTop: 2,
    fontSize: 10,
    color: '#89867E',
    paddingRight: 10,
  },
  tableTertiary: {
    marginTop: 2,
    fontSize: 9,
    color: '#9A968D',
    paddingRight: 10,
  },
  callableText: {
    color: '#2F5F78',
    fontWeight: '800',
  },
  tableCellText: {
    fontSize: 11,
    lineHeight: 15,
    color: '#5F5C55',
    paddingRight: 10,
  },
  tableCellStrong: {
    fontSize: 11,
    fontWeight: '800',
    color: '#282722',
  },
  colOpportunity: { width: 260 },
  colStage: { width: 160 },
  colAmount: { width: 105 },
  colClose: { width: 145 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E9E7E2' },
  summaryLabel: { flex: 1, color: '#4B4943', fontSize: 12 },
  summaryValue: { color: '#22211F', fontSize: 13, fontWeight: '850' },
  contextTitle: { fontSize: 20, lineHeight: 25, color: '#22211F', fontWeight: '850', paddingHorizontal: 14, paddingTop: 8 },
  contextAccount: { fontSize: 11, color: '#817D75', paddingHorizontal: 14, marginTop: 3 },
  contextMetrics: { flexDirection: 'row', margin: 14, gap: 8 },
  contextMetric: { flex: 1, backgroundColor: '#F5F4F0', borderRadius: 12, padding: 10 },
  contextMetricLabel: { fontSize: 8, color: '#99958D', fontWeight: '900', letterSpacing: 0.6 },
  contextMetricValue: { fontSize: 11, color: '#2A2926', fontWeight: '800', marginTop: 4 },
  contextInfoCard: { marginHorizontal: 14, marginBottom: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E3E1DA', paddingTop: 10 },
  contextLine: { color: '#5E5B54', fontSize: 11, lineHeight: 17, marginBottom: 3 },
  contactActionCard: { marginHorizontal: 14, marginBottom: 10, padding: 11, borderRadius: 12, backgroundColor: '#F2F5F6', flexDirection: 'row', alignItems: 'center' },
  callAction: { color: '#2F5F78', fontSize: 11, fontWeight: '900' },
  contextActivityCount: { paddingHorizontal: 14, paddingBottom: 13, color: '#969289', fontSize: 10 },
  taskCard: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E9E7E2' },
  taskRight: { alignItems: 'flex-end', marginLeft: 12 },
  taskDate: { color: '#33312D', fontSize: 11, fontWeight: '800' },
  eventCard: {
    flexDirection: 'row',
    paddingHorizontal: 13,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E9E7E2',
  },
  eventTimeCol: {
    width: 82,
  },
  eventTime: {
    fontSize: 12,
    fontWeight: '800',
    color: '#262521',
  },
  eventDate: {
    marginTop: 3,
    fontSize: 9,
    lineHeight: 13,
    color: '#969289',
  },
  eventDivider: {
    width: 2,
    borderRadius: 99,
    backgroundColor: '#D7D4CB',
    marginHorizontal: 10,
  },
  eventMain: {
    flex: 1,
  },
  eventSubject: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    color: '#262521',
  },
  eventMeta: {
    marginTop: 3,
    fontSize: 11,
    lineHeight: 15,
    color: '#69665F',
  },
  eventLocation: {
    marginTop: 5,
    fontSize: 10,
    color: '#89867E',
  },
  simpleDataCard: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E9E7E2',
  },
  simpleDataTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#262521',
  },
  simpleDataMeta: {
    marginTop: 3,
    fontSize: 11,
    lineHeight: 16,
    color: '#77746D',
  },
  listenButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: '#ECEAE4',
  },
  listenButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#66635C',
  },
  sourcesWrap: {
    marginTop: 15,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DDDAD3',
  },
  sourcesLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
    color: '#99968E',
    marginBottom: 5,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
  },
  sourceIndex: {
    width: 22,
    height: 22,
    borderRadius: 7,
    textAlign: 'center',
    lineHeight: 22,
    backgroundColor: '#ECEAE4',
    color: '#67645D',
    fontSize: 10,
    fontWeight: '800',
    marginRight: 8,
  },
  sourceTitle: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    color: '#56534D',
  },
  sourceArrow: {
    marginLeft: 8,
    color: '#8F8B83',
    fontSize: 14,
  },
  systemBubble: {
    marginBottom: 18,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#FFF0F0',
  },
  systemBubbleText: {
    color: '#8A2A2A',
    fontSize: 13,
    lineHeight: 18,
  },
  processingCard: {
    marginLeft: 38,
    marginRight: 16,
    marginBottom: 18,
    backgroundColor: '#F4F3EF',
    borderWidth: 1,
    borderColor: '#E2E0D9',
    borderRadius: 16,
    padding: 12,
  },
  processingHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  processingMark: { width: 26, height: 26, borderRadius: 9, backgroundColor: '#20211F', alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  processingMarkText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  processingTitle: { color: '#292825', fontSize: 12, fontWeight: '850' },
  processingRequest: { color: '#99958D', fontSize: 9, marginTop: 2 },
  processingSteps: { marginTop: 2 },
  processingStep: { flexDirection: 'row', alignItems: 'center', minHeight: 28, gap: 8 },
  processingCheck: { width: 18, color: '#5F6D5F', fontSize: 12, fontWeight: '900', textAlign: 'center' },
  processingStepText: { flex: 1, color: '#89857D', fontSize: 11, lineHeight: 16 },
  processingStepTextActive: { color: '#393834', fontWeight: '750' },

  quickPromptsWrap: {
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  quickPromptsLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.7,
    color: '#918E86',
    marginBottom: 8,
  },
  quickPromptsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickPrompt: {
    borderWidth: 1,
    borderColor: '#DAD8D1',
    backgroundColor: '#FBFBF9',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 13,
  },
  quickPromptText: {
    color: '#47453F',
    fontSize: 13,
  },

  confirmCard: {
    marginTop: 4,
    marginBottom: 22,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#D7D5CE',
    backgroundColor: '#FFFFFF',
    padding: 17,
  },
  confirmHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  confirmEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.0,
    color: '#8A877F',
  },
  confirmTitle: {
    marginTop: 3,
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#191918',
  },
  pendingPill: {
    backgroundColor: '#FFF1CF',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pendingPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#7D5E13',
  },
  confirmBody: {
    marginTop: 14,
    color: '#67645D',
    lineHeight: 20,
  },
  changeBlock: {
    marginTop: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E4E2DC',
    paddingTop: 14,
  },
  eventReviewCard: {
    marginTop: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E4E2DC',
    paddingTop: 14,
  },
  eventReviewLine: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
    color: '#5F5C55',
  },
  eventReviewDescription: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#F5F4F0',
    fontSize: 11,
    lineHeight: 16,
    color: '#69665F',
  },
  changeRecord: {
    fontSize: 14,
    fontWeight: '700',
    color: '#24231F',
  },
  changeField: {
    marginTop: 2,
    fontSize: 12,
    color: '#8A877F',
  },
  changeValuesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 11,
  },
  changeValueCol: {
    flex: 1,
  },
  changeLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.7,
    color: '#9B9890',
  },
  changeOld: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: '#69665F',
  },
  changeNew: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: '#20201D',
  },
  arrow: {
    marginHorizontal: 10,
    color: '#A3A097',
    fontSize: 18,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  cancelButton: {
    flex: 1,
    minHeight: 47,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#D7D5CE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontWeight: '700',
    color: '#4E4C46',
  },
  confirmButton: {
    flex: 1.55,
    minHeight: 47,
    borderRadius: 13,
    backgroundColor: '#171717',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  composerWrap: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 6 : 10,
    backgroundColor: '#F7F7F4',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DAD9D4',
  },
  composer: {
    minHeight: 54,
    maxHeight: 132,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#D5D3CC',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  micButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
    backgroundColor: '#F0EFEA',
  },
  micButtonActive: {
    backgroundColor: '#1E1E1D',
  },
  micText: {
    fontSize: 17,
  },
  micTextActive: {
    opacity: 1,
    color: '#FFFFFF',
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 114,
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 7,
    fontSize: 16,
    lineHeight: 21,
    color: '#1F1F1D',
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#191919',
    marginLeft: 5,
  },
  sendButtonDisabled: {
    backgroundColor: '#CBC9C2',
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 23,
    lineHeight: 25,
    fontWeight: '500',
    marginTop: -2,
  },
  composerHint: {
    textAlign: 'center',
    marginTop: 6,
    color: '#97948D',
    fontSize: 10,
  },
  voiceHint: {
    color: '#57544E',
    fontWeight: '600',
  },
  locationBadge: {
    marginTop: 3,
    fontSize: 10,
    color: '#6B6962',
    fontWeight: '600',
  },
  locationBadgeDemo: { color: '#8A5A16' },
  topTabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#DAD9D4',
    backgroundColor: '#F7F7F4',
  },
  topTab: {
    minHeight: 42,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  topTabActive: { borderBottomColor: '#1F1F1D' },
  topTabText: { fontSize: 13, color: '#8B8880', fontWeight: '700' },
  topTabTextActive: { color: '#1F1F1D' },
  tabCount: { marginLeft: 6, backgroundColor: '#E4E1D9', borderRadius: 9, paddingHorizontal: 6, paddingVertical: 2 },
  tabCountText: { fontSize: 9, fontWeight: '800', color: '#59564F' },
  nearbyCard: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DFDDD6', paddingVertical: 13 },
  nearbyTopRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  distancePill: { backgroundColor: '#ECE8DC', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5 },
  distanceText: { color: '#5E5543', fontSize: 11, fontWeight: '800' },
  nearbyPipeline: { fontSize: 12, color: '#1F1F1D', fontWeight: '800', marginTop: 8 },
  sessionsScreen: { flex: 1, backgroundColor: '#F7F7F4' },
  sessionsContent: { padding: 16, paddingBottom: 56 },
  startSessionCard: { backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, borderWidth: 1, borderColor: '#E1DFD8' },
  sessionSectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  sessionEyebrow: { fontSize: 10, letterSpacing: 1.1, color: '#8A877F', fontWeight: '800' },
  sessionHeading: { fontSize: 22, color: '#1E1E1D', fontWeight: '800', marginTop: 3 },
  sessionLocationSmall: { maxWidth: 140, textAlign: 'right', fontSize: 10, color: '#77736B' },
  sourceCard: { flexDirection: 'row', alignItems: 'center', marginTop: 12, padding: 13, borderRadius: 15, borderWidth: 1, borderColor: '#DEDDD7', backgroundColor: '#FAFAF8' },
  sourceCardSelected: { borderColor: '#1F1F1D', backgroundColor: '#F4F3EE' },
  sourceRadio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#A8A49B', marginRight: 11 },
  sourceRadioSelected: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#1F1F1D', marginRight: 11, alignItems: 'center', justifyContent: 'center' },
  sourceRadioInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1F1F1D' },
  sourceTitle: { fontSize: 14, fontWeight: '800', color: '#232321' },
  sourceMeta: { fontSize: 11, color: '#7D7971', marginTop: 2 },
  readyPill: { fontSize: 10, color: '#2E6A45', backgroundColor: '#E5F2E9', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, fontWeight: '800' },
  offlinePill: { fontSize: 10, color: '#77736B', backgroundColor: '#EDEBE5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, fontWeight: '800' },
  voicePuckLink: { marginTop: 12, alignSelf: 'flex-start' },
  voicePuckLinkText: { color: '#5B594F', fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' },
  startSessionButton: { marginTop: 18, borderRadius: 16, minHeight: 52, backgroundColor: '#1E1E1D', alignItems: 'center', justifyContent: 'center' },
  startSessionButtonDisabled: { opacity: 0.42 },
  startSessionButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  recordingHero: { backgroundColor: '#1E1E1D', borderRadius: 24, paddingVertical: 36, paddingHorizontal: 22, alignItems: 'center' },
  recordingEyebrow: { color: '#B9B6AE', fontSize: 10, letterSpacing: 1.2, fontWeight: '800' },
  recordingDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#D8453D', marginTop: 24 },
  recordingTimer: { color: '#FFFFFF', fontSize: 48, fontWeight: '300', fontVariant: ['tabular-nums'], marginTop: 10 },
  recordingTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', marginTop: 4 },
  recordingBody: { color: '#C5C2B9', fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 280, marginTop: 10 },
  stopSessionButton: { marginTop: 24, backgroundColor: '#FFFFFF', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 26 },
  stopSessionButtonText: { color: '#1E1E1D', fontWeight: '800' },
  localSessionCard: { marginTop: 14, backgroundColor: '#FFF7E8', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#EAD9B6' },
  localSessionTitle: { fontSize: 15, fontWeight: '800', color: '#3D3424', marginTop: 3 },
  errorInline: { color: '#9C3F37', fontSize: 11, lineHeight: 16, marginTop: 7 },
  secondaryAction: { marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#ECEAE4', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  secondaryActionText: { fontSize: 11, fontWeight: '800', color: '#3B3934' },
  sessionListHeader: { marginTop: 26, marginBottom: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  refreshText: { color: '#4F596B', fontSize: 11, fontWeight: '800', textDecorationLine: 'underline' },
  emptySessions: { color: '#858178', fontSize: 12, lineHeight: 18, marginTop: 12 },
  sessionRowCard: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 10, marginTop: 9, borderWidth: 1, borderColor: '#E1DFD8', flexDirection: 'row', alignItems: 'center' },
  sessionRowOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 5 },
  sessionDeleteButton: { marginLeft: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: '#FFF0EE' },
  sessionDeleteButtonText: { color: '#A1433B', fontSize: 10, fontWeight: '850' },
  sessionRowTitle: { color: '#252421', fontSize: 14, fontWeight: '800' },
  sessionRowMeta: { color: '#807C74', fontSize: 11, marginTop: 4 },
  linkedMeta: { color: '#576452', fontSize: 11, marginTop: 5, fontWeight: '700' },
  rowArrow: { color: '#A19E96', fontSize: 26, marginLeft: 8 },
  sessionDetailContent: { padding: 16, paddingBottom: 60 },
  backLink: { color: '#69665F', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  sessionDetailTitle: { fontSize: 26, lineHeight: 31, fontWeight: '850', color: '#1E1E1D' },
  sessionDetailMeta: { color: '#817D75', fontSize: 11, marginTop: 6, marginBottom: 10 },
  detailCard: { backgroundColor: '#FFFFFF', borderRadius: 17, padding: 15, borderWidth: 1, borderColor: '#E2E0D9', marginTop: 11 },
  detailCardEyebrow: { fontSize: 10, letterSpacing: 1.0, color: '#8A877F', fontWeight: '800', marginBottom: 7 },
  detailLine: { fontSize: 12, color: '#5F5C56', marginTop: 3 },
  detailLineStrong: { fontSize: 14, color: '#232321', fontWeight: '800', marginTop: 2 },
  detailSubline: { fontSize: 11, color: '#7C7870', lineHeight: 16, marginTop: 4 },
  detailActionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  miniAction: { backgroundColor: '#ECEAE4', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10 },
  miniActionText: { fontSize: 11, fontWeight: '800', color: '#35332F' },
  voicePuckDetailRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E3E1DB', marginTop: 13, paddingTop: 12, flexDirection: 'row', alignItems: 'center' },
  warningCard: { backgroundColor: '#FFF1EF', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#E8C3BE', marginTop: 12 },
  warningTitle: { color: '#7A2F29', fontSize: 13, fontWeight: '800' },
  warningText: { color: '#82443E', fontSize: 11, lineHeight: 16, marginTop: 5 },
  summaryBody: { fontSize: 14, color: '#34322E', lineHeight: 21 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 6 },
  bulletDot: { width: 16, fontSize: 14, color: '#77736B' },
  bulletText: { flex: 1, fontSize: 12, lineHeight: 18, color: '#3D3A35' },
  linkOptionsWrap: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E3E1DB' },
  linkOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E3E1DB' },
  linkOptionTitle: { fontSize: 12, fontWeight: '800', color: '#34322E' },
  unlinkText: { color: '#8B4942', fontSize: 11, fontWeight: '700', marginTop: 10 },
  transcriptRow: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E3DD', paddingTop: 10 },
  transcriptSpeaker: { fontSize: 10, color: '#5C5A54', fontWeight: '800', textTransform: 'uppercase' },
  transcriptTime: { fontSize: 9, color: '#A09C94', marginTop: 2 },
  transcriptText: { fontSize: 12, lineHeight: 18, color: '#36342F', marginTop: 5 },
  centeredContent: { width: '100%', maxWidth: 900, alignSelf: 'center' },
  responsiveBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  primaryPane: { flex: 1, minWidth: 0, backgroundColor: '#F7F7F4' },
  navRail: { width: 184, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: '#DAD9D4', backgroundColor: '#F2F1EC', paddingHorizontal: 14, paddingTop: 18 },
  navEyebrow: { fontSize: 9, letterSpacing: 1.0, fontWeight: '850', color: '#908C83', marginBottom: 7 },
  navItem: { minHeight: 40, borderRadius: 11, paddingHorizontal: 11, justifyContent: 'center', marginBottom: 4 },
  navItemActive: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0DED6' },
  navItemText: { fontSize: 13, fontWeight: '750', color: '#77736B' },
  navItemTextActive: { color: '#1F1F1D' },
  navDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#D7D4CC', marginVertical: 15 },
  navStatus: { fontSize: 10, lineHeight: 16, color: '#6E6B63', marginBottom: 4 },
  contextRail: { width: 252, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#DAD9D4', backgroundColor: '#F2F1EC', padding: 16 },
  contextEyebrow: { fontSize: 9, letterSpacing: 1.1, color: '#918E86', fontWeight: '850' },
  contextTitle: { fontSize: 17, fontWeight: '850', color: '#232321', marginTop: 4, marginBottom: 12 },
  contextCard: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#E0DED7', padding: 12, marginBottom: 9 },
  contextLabel: { fontSize: 8, letterSpacing: 1, fontWeight: '850', color: '#97938A' },
  contextValue: { fontSize: 12, lineHeight: 17, fontWeight: '750', color: '#34322E', marginTop: 5 },
  contextMeta: { fontSize: 10, lineHeight: 15, color: '#77736B', marginTop: 4 },
  layoutPill: { backgroundColor: '#ECEAE3', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5 },
  layoutPillText: { fontSize: 8, letterSpacing: 0.7, fontWeight: '850', color: '#77736B' },
  debugPanelWide: { maxWidth: 900, width: '100%', alignSelf: 'center' },
  quickPromptsRowWide: { flexDirection: 'row', flexWrap: 'wrap' },
  sessionsContentWide: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingHorizontal: 26 },
  sourceGrid: { width: '100%' },
  sourceGridWide: { flexDirection: 'row', gap: 10 },
  sourceCardWide: { flex: 1, minWidth: 0 },
  voicePuckPanel: { marginTop: 14, borderRadius: 17, borderWidth: 1, borderColor: '#DEDCD4', backgroundColor: '#FAFAF7', padding: 14 },
  voicePuckPanelHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  voicePuckPanelTitle: { fontSize: 16, color: '#24231F', fontWeight: '850', marginTop: 3 },
  voicePuckCompactMeta: { marginTop: 4, fontSize: 11, lineHeight: 16, color: '#76726A', textTransform: 'capitalize' },
  voicePuckDetailsToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 10, backgroundColor: '#F0EEE8' },
  voicePuckDetailsToggleText: { fontSize: 10, fontWeight: '800', color: '#5F5B54' },
  voicePuckChevron: { fontSize: 13, lineHeight: 13, color: '#77736C' },
  voicePuckCompactPending: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DEDBD4', paddingTop: 11 },
  voicePuckDisconnect: { alignSelf: 'flex-start', marginTop: 13, paddingVertical: 5 },
  voicePuckDisconnectText: { fontSize: 10, fontWeight: '700', color: '#8B5750', textDecorationLine: 'underline' },
  voicePuckDeviceRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E1DED7', paddingVertical: 10, marginTop: 8 },
  voicePuckStatsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  voicePuckStat: { flex: 1, minWidth: 0, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E1D9', paddingHorizontal: 9, paddingVertical: 9 },
  voicePuckStatLabel: { fontSize: 7, letterSpacing: 0.8, color: '#969188', fontWeight: '850' },
  voicePuckStatValue: { fontSize: 11, color: '#34322E', fontWeight: '800', marginTop: 4, textTransform: 'capitalize' },
  wifiBox: { marginTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DEDBD4', paddingTop: 12 },
  wifiInput: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D9D6CE', borderRadius: 11, minHeight: 42, paddingHorizontal: 11, fontSize: 13, color: '#262521', marginTop: 8 },
  pendingBox: { marginTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DEDBD4', paddingTop: 12 },
  pendingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  pendingId: { flex: 1, fontSize: 10, color: '#69655E', marginRight: 10 },
  oppCompactCard: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E1DED7', paddingVertical: 13 },
  oppCompactTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  oppCompactAmount: { fontSize: 13, fontWeight: '850', color: '#282722', marginLeft: 8 },
  oppCompactMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 8 },
  oppCompactMeta: { flex: 1, fontSize: 10, color: '#757169', fontWeight: '700' },

});
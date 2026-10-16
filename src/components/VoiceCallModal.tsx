/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  Square,
  X,
  CheckCircle2,
  AlertCircle,
  Building2,
  User,
  Phone,
  Mail,
  Save,
  RotateCcw,
  Volume2,
  Calendar,
  Clock,
  Sparkles,
} from 'lucide-react';
import { CallStage, FreeWebsiteStatus, Lead, STAGE_CONFIG, VoiceSegregationResult } from '../types/lead';
import { formatDayDate, resolveDateAndTimeString } from '../utils/dateResolver';
import { extractLeadDetails } from '../utils/intelligentExtractor';

interface VoiceCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  leads: Lead[];
  onApplyVoiceUpdate: (result: VoiceSegregationResult, matchedLead: Lead | null) => Promise<void>;
}

export const VoiceCallModal: React.FC<VoiceCallModalProps> = ({
  isOpen,
  onClose,
  leads,
  onApplyVoiceUpdate,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [audioMimeType, setAudioMimeType] = useState<string>('audio/webm');
  const [audioLevel, setAudioLevel] = useState<number>(0);

  // Segregated results state
  const [segregatedResult, setSegregatedResult] = useState<VoiceSegregationResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form fields
  const [editCompany, setEditCompany] = useState('');
  const [editDirector, setEditDirector] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCallNumber, setEditCallNumber] = useState<1 | 2 | 3 | 4>(1);
  const [editCallDate, setEditCallDate] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editFreeWebsiteStatus, setEditFreeWebsiteStatus] = useState<FreeWebsiteStatus>('Not Asked');

  // Follow-up and Meeting fields
  const [editHasFollowUp, setEditHasFollowUp] = useState(false);
  const [editFollowUpDate, setEditFollowUpDate] = useState('');
  const [editFollowUpTime, setEditFollowUpTime] = useState('');
  const [editFollowUpType, setEditFollowUpType] = useState('Follow-up Call');
  const [editScheduledMeeting, setEditScheduledMeeting] = useState('None');
  const [isMeetingChecked, setIsMeetingChecked] = useState(false);

  // Audio refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);
  const timerRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      stopRecordingCleanup();
      setTranscript('');
      setSegregatedResult(null);
      setErrorMsg(null);
      setAudioUrl(null);
      setAudioBase64(null);
      setRecordingSeconds(0);
      setAudioLevel(0);
      setEditCompany('');
      setEditDirector('');
      setEditPhone('');
      setEditEmail('');
      setEditNote('');
      setEditScheduledMeeting('None');
      setIsMeetingChecked(false);
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      stopRecordingCleanup();
    };
  }, []);

  const stopRecordingCleanup = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // ignore
      }
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // ignore
      }
      recognitionRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (e) {
        // ignore
      }
      audioContextRef.current = null;
    }
    setIsRecording(false);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const startRecording = async () => {
    setErrorMsg(null);
    setAudioUrl(null);
    setAudioBase64(null);
    audioChunksRef.current = [];

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMsg('Audio recording is not supported in this browser. You can type or paste spoken text.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      mediaStreamRef.current = stream;

      // AudioContext analyzer
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          const ctx = new AudioContextClass();
          audioContextRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const updateAudioLevel = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const average = sum / dataArray.length;
            setAudioLevel(Math.min(100, Math.round((average / 128) * 100)));
            animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
          };
          updateAudioLevel();
        }
      } catch (err) {
        // Non-fatal
      }

      let mimeType = 'audio/webm';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      }
      setAudioMimeType(mimeType);

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioBlob.size > 0) {
          const url = URL.createObjectURL(audioBlob);
          setAudioUrl(url);
          try {
            const b64 = await blobToBase64(audioBlob);
            setAudioBase64(b64);
          } catch (err) {
            console.error('Failed to encode audio:', err);
          }
        }
      };

      recorder.start(500);
      setIsRecording(true);
      setRecordingSeconds(0);

      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      // Web Speech API for real-time speech-to-text
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-IN';

          recognition.onresult = (event: any) => {
            let fullText = '';
            for (let i = 0; i < event.results.length; i++) {
              fullText += event.results[i][0].transcript + ' ';
            }
            if (fullText.trim()) {
              setTranscript(fullText.trim());
            }
          };

          recognitionRef.current = recognition;
          recognition.start();
        } catch (speechErr) {
          console.warn('SpeechRecognition note:', speechErr);
        }
      }
    } catch (err: any) {
      console.error('Mic error:', err);
      const denied = err?.name === 'NotAllowedError' || /denied|permission/i.test(err?.message || '');
      setErrorMsg(
        denied
          ? 'Microphone blocked. Open this app in Chrome or Safari (not an embedded preview), click the lock icon in the address bar, set Microphone to Allow, then reload. Also check System Settings > Privacy & Security > Microphone for that browser. You can still type or paste the call note.'
          : `Microphone error: ${err.message || 'Unable to access microphone'}`
      );
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    stopRecordingCleanup();
  };

  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Populate form fields with extracted results
  const applyExtractedResults = (result: VoiceSegregationResult) => {
    setSegregatedResult(result);
    setEditCompany(result.companyName || '');
    setEditDirector(result.directorName || '');
    setEditPhone(result.companyNumber || '');
    setEditEmail(result.email || '');
    setEditCallNumber(result.callNumber || 1);
    setEditCallDate(result.callDate || formatDayDate(new Date()));
    setEditNote(result.callNote || '');
    setEditFreeWebsiteStatus(result.freeWebsiteStatus || 'Not Asked');

    const hasFollowUp = Boolean(result.hasNextFollowUp || result.nextFollowUpDate);
    setEditHasFollowUp(hasFollowUp);
    setEditFollowUpDate(result.nextFollowUpDate || '');
    setEditFollowUpTime(result.nextFollowUpTime || '');
    setEditFollowUpType(result.nextFollowUpType || (hasFollowUp ? 'Follow-up Call' : 'None'));

    const isMeeting =
      result.nextFollowUpType === 'Meeting Scheduled' ||
      (Boolean(result.scheduledMeeting) && result.scheduledMeeting !== 'None');

    setIsMeetingChecked(isMeeting);
    setEditScheduledMeeting(
      result.scheduledMeeting && result.scheduledMeeting !== 'None'
        ? result.scheduledMeeting
        : isMeeting && result.nextFollowUpDate
        ? `${result.nextFollowUpDate}${result.nextFollowUpTime ? ` @ ${result.nextFollowUpTime}` : ''}`
        : 'None'
    );
  };

  // Instant Segregation: 0-Lag Client-Side Engine + Fast AI Refinement
  const handleSegregateDetails = async () => {
    const textToSegregate = transcript.trim();
    if (!textToSegregate && !audioBase64) {
      setErrorMsg('Please record or enter call notes first.');
      return;
    }

    if (isRecording) {
      stopRecording();
    }

    setErrorMsg(null);

    // 1. EXTENSIVE OPTIMIZATION: Instant Client-Side Extraction (0ms)
    // User sees the UI update immediately without any wait!
    if (textToSegregate) {
      const instantResult = extractLeadDetails(textToSegregate, new Date());
      applyExtractedResults(instantResult);
    }

    // 2. Parallel Fast AI Call to refine details with zero blocking
    setIsProcessing(true);
    try {
      const payload: any = {
        clientDate: new Date().toISOString(),
      };
      if (textToSegregate) {
        payload.text = textToSegregate;
      }
      // Always send the recording too: the browser transcript garbles names, the audio does not.
      if (audioBase64) {
        payload.audioBase64 = audioBase64;
        payload.mimeType = audioMimeType;
      }
      payload.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      payload.knownCompanies = Array.from(
        new Set(leads.map((l) => (l.companyName || '').trim()).filter(Boolean))
      );
      payload.knownPeople = Array.from(
        new Set(leads.map((l) => (l.directorName || '').trim()).filter(Boolean))
      );

      const res = await fetch('/api/voice/segregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const aiResult: VoiceSegregationResult = await res.json();
        // Seamlessly refine any field if better
        if (aiResult.companyName && aiResult.companyName !== 'New Lead') {
          applyExtractedResults(aiResult);
        }
        if (aiResult.transcription && !transcript) {
          setTranscript(aiResult.transcription);
        }
      }
    } catch (err: any) {
      console.warn('Background AI refinement note:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Match existing lead in table
  const matchedLead = React.useMemo(() => {
    if (!editCompany) return null;
    const cleanTarget = editCompany.toLowerCase().trim();
    return (
      leads.find((l) => {
        const leadCo = (l.companyName || '').toLowerCase().trim();
        return leadCo.includes(cleanTarget) || cleanTarget.includes(leadCo);
      }) || null
    );
  }, [editCompany, leads]);

  const handleSaveToSheet = async () => {
    if (!editCompany.trim()) {
      setErrorMsg('Company Name is required.');
      return;
    }
    if (!editNote.trim()) {
      setErrorMsg('Call note cannot be empty.');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);

    try {
      const finalStage: CallStage = `CALL_${editCallNumber}` as CallStage;

      let finalMeeting = editScheduledMeeting;
      if (isMeetingChecked && editFollowUpDate) {
        finalMeeting = editFollowUpTime ? `${editFollowUpDate} @ ${editFollowUpTime}` : editFollowUpDate;
      } else if (!isMeetingChecked) {
        finalMeeting = 'None';
      }

      const finalResult: VoiceSegregationResult = {
        companyName: editCompany.trim(),
        directorName: editDirector.trim(),
        companyNumber: editPhone.trim(),
        email: editEmail.trim(),
        callNumber: editCallNumber,
        callStage: finalStage,
        callLabel: `Call ${editCallNumber}`,
        callDate: editCallDate.trim() || formatDayDate(new Date()),
        callNote: editNote.trim(),
        freeWebsiteStatus: editFreeWebsiteStatus,
        hasNextFollowUp: editHasFollowUp,
        nextFollowUpDate: editHasFollowUp ? editFollowUpDate.trim() : '',
        nextFollowUpTime: editHasFollowUp ? editFollowUpTime.trim() : '',
        nextFollowUpType: isMeetingChecked ? 'Meeting Scheduled' : editHasFollowUp ? editFollowUpType : 'None',
        scheduledMeeting: finalMeeting,
        callOutcome: isMeetingChecked
          ? 'Meeting Scheduled'
          : editHasFollowUp
          ? 'Follow-up Scheduled'
          : 'Connected & Discussed',
      };

      await onApplyVoiceUpdate(finalResult, matchedLead);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update Google Sheet.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/65 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header - Simple and Clean (no tags/presets) */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center shadow-md font-bold shrink-0">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Voice Call Logger
              </h2>
              <p className="text-xs text-slate-500">
                Speak your call conversation naturally: company, call number, follow-up, and notes.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {errorMsg && (
          <div className="mt-3 p-3 rounded-lg bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 text-xs border border-rose-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {/* Recording Area */}
          <div className="p-5 rounded-2xl bg-gradient-to-b from-slate-50 to-slate-100/70 dark:from-slate-850 dark:to-slate-900 border border-slate-200 dark:border-slate-800 text-center space-y-3 relative overflow-hidden">
            <div className="flex flex-col items-center justify-center">
              <div className="relative">
                {isRecording && (
                  <div
                    className="absolute inset-0 rounded-full bg-rose-500/20 animate-ping pointer-events-none"
                    style={{ transform: `scale(${1 + audioLevel / 100})` }}
                  />
                )}
                <button
                  type="button"
                  onClick={handleToggleRecording}
                  className={`w-18 h-18 rounded-full flex items-center justify-center shadow-xl transition-all cursor-pointer relative z-10 ${
                    isRecording
                      ? 'bg-rose-600 text-white scale-105 shadow-rose-500/40'
                      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/30 hover:scale-105'
                  }`}
                  title={isRecording ? 'Click to stop recording' : 'Click to start speaking'}
                >
                  {isRecording ? <Square className="w-7 h-7 fill-white" /> : <Mic className="w-8 h-8" />}
                </button>
              </div>

              <div className="mt-3">
                <span className="text-sm font-bold text-slate-800 dark:text-slate-100 block">
                  {isRecording ? `Recording... (${recordingSeconds}s)` : 'Click Mic to Record'}
                </span>
                <span className="text-xs text-slate-500">
                  {isRecording
                    ? 'Speak clearly: e.g. "Calling Arab Bakery today for Call 2, meeting scheduled tomorrow at 3 PM"'
                    : 'Instant voice-to-CRM segregation'}
                </span>
              </div>

              {isRecording && (
                <div className="w-48 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden mt-3">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-75"
                    style={{ width: `${Math.max(8, audioLevel)}%` }}
                  />
                </div>
              )}

              {audioUrl && !isRecording && (
                <div className="mt-3 flex items-center gap-2 p-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
                  <Volume2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="font-medium text-slate-700 dark:text-slate-300">Recorded Audio</span>
                  <audio src={audioUrl} controls className="h-7 w-48 ml-2" />
                </div>
              )}
            </div>
          </div>

          {/* Transcript / Spoken Text Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Spoken Transcript:
              </label>
              {transcript && (
                <button
                  type="button"
                  onClick={() => {
                    setTranscript('');
                    setSegregatedResult(null);
                  }}
                  className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>

            <textarea
              rows={3}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Your voice note transcript will appear here, or you can type directly..."
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500 outline-none leading-relaxed"
            />

            <div className="mt-2 flex items-center justify-end">
              <button
                type="button"
                onClick={handleSegregateDetails}
                disabled={!transcript.trim() && !audioBase64}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                <span>Accurately Segregate Details</span>
              </button>
            </div>
          </div>

          {/* Segregated Structured Results Preview */}
          {segregatedResult && (
            <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/30 dark:bg-blue-950/20 space-y-4 animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-blue-900 dark:text-blue-200">
                    Segregated Lead Fields
                  </h3>
                </div>

                {matchedLead ? (
                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Matches Existing Lead: {matchedLead.companyName}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                    New Lead
                  </span>
                )}
              </div>

              {/* Call Number & Date Selector */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-white dark:bg-slate-850 rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                    Call Number:
                  </span>
                  <div className="flex items-center gap-1.5">
                    {([1, 2, 3, 4] as const).map((num) => (
                      <button
                        key={num}
                        type="button"
                        onClick={() => setEditCallNumber(num)}
                        className={`px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                          editCallNumber === num
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'
                        }`}
                      >
                        Call {num}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Call Date:</span>
                  <input
                    type="text"
                    value={editCallDate}
                    onChange={(e) => setEditCallDate(e.target.value)}
                    placeholder="e.g. Friday, Oct 16, 2026"
                    className="bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 w-44"
                  />
                </div>
              </div>

              {/* Company & Contact Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Company Name *
                  </label>
                  <div className="relative">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Director / Contact Name
                  </label>
                  <div className="relative">
                    <User className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={editDirector}
                      onChange={(e) => setEditDirector(e.target.value)}
                      placeholder="e.g. Marcus Sterling"
                      className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Phone Number
                  </label>
                  <div className="relative">
                    <Phone className="w-3.5 h-3.5 text-emerald-600 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      placeholder="e.g. +1 555-0192"
                      className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Gmail / Email
                  </label>
                  <div className="relative">
                    <Mail className="w-3.5 h-3.5 text-blue-600 absolute left-2.5 top-2.5" />
                    <input
                      type="email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      placeholder="contact@company.com"
                      className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Single Clean Note Field for this call */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Call {editCallNumber} Note (What Was Discussed):
                </label>
                <textarea
                  rows={3}
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="Conversation notes..."
                  className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 outline-none leading-relaxed"
                />
              </div>

              {/* Scheduled Meetings & Next Follow-up Section */}
              <div className="p-3.5 rounded-xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/80 text-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-amber-950 dark:text-amber-200 text-xs">
                    <Calendar className="w-4 h-4 text-amber-600" />
                    <span>Follow-up & Scheduled Meetings:</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 cursor-pointer text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={editHasFollowUp}
                        onChange={(e) => setEditHasFollowUp(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-blue-600"
                      />
                      <span>Follow-up Call</span>
                    </label>

                    <label className="flex items-center gap-1.5 cursor-pointer text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-950 px-2 py-0.5 rounded">
                      <input
                        type="checkbox"
                        checked={isMeetingChecked}
                        onChange={(e) => {
                          setIsMeetingChecked(e.target.checked);
                          if (e.target.checked) {
                            setEditHasFollowUp(true);
                            setEditFollowUpType('Meeting Scheduled');
                          }
                        }}
                        className="w-3.5 h-3.5 rounded text-emerald-600"
                      />
                      <span>Scheduled Meeting</span>
                    </label>
                  </div>
                </div>

                {(editHasFollowUp || isMeetingChecked) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Day & Date:
                      </label>
                      <input
                        type="text"
                        value={editFollowUpDate}
                        onChange={(e) => setEditFollowUpDate(e.target.value)}
                        placeholder="e.g. Saturday, Oct 17, 2026"
                        className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                        Time (if mentioned):
                      </label>
                      <input
                        type="text"
                        value={editFollowUpTime}
                        onChange={(e) => setEditFollowUpTime(e.target.value)}
                        placeholder="e.g. 3:00 PM"
                        className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                )}

                {/* Scheduled Meeting Output Preview */}
                <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800/50 flex items-center justify-between text-xs">
                  <span className="text-slate-600 dark:text-slate-400">Scheduled Meeting Column:</span>
                  <span className="font-bold text-amber-900 dark:text-amber-200">
                    {isMeetingChecked && editFollowUpDate
                      ? `${editFollowUpDate}${editFollowUpTime ? ` @ ${editFollowUpTime}` : ''}`
                      : editScheduledMeeting !== 'None'
                      ? editScheduledMeeting
                      : 'None'}
                  </span>
                </div>
              </div>

              {/* Free Website Status */}
              <div className="p-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-800/60 text-xs space-y-1.5">
                <span className="font-bold text-indigo-950 dark:text-indigo-200 text-xs">
                  Free Website Status:
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {[
                    { id: 'To Send Free Website', label: 'To Send Free Website' },
                    { id: 'Free Website Sent', label: 'Website Sent' },
                    { id: 'Website Reviewing', label: 'Under Review' },
                    { id: 'Not Asked', label: 'Not Asked' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setEditFreeWebsiteStatus(opt.id as any)}
                      className={`px-2 py-1.5 rounded text-[11px] font-medium border text-center transition-all cursor-pointer ${
                        editFreeWebsiteStatus === opt.id
                          ? 'bg-indigo-600 text-white border-indigo-600 font-bold shadow-xs'
                          : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Confirm & Save */}
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveToSheet}
                  disabled={isSaving}
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{isSaving ? 'Syncing to Sheet...' : 'Confirm & Save to Google Sheets'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

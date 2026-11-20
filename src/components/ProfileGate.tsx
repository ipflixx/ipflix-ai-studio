import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import type { ProfileAvatarId, UserProfile } from '../types/iptv';
import { useI18n } from '../i18n/I18nContext';
import { AVATAR_PRESETS, ProfileAvatar } from './ProfileAvatar';
import { BrandMark } from './BrandMark';

export const MAX_PROFILES = 5;

// ============================================================================
// Reusable Netflix-Style Create / Edit Profile Modal (used by ProfileGate & Settings)
// ============================================================================
interface ProfileEditorModalProps {
  isOpen: boolean;
  editingProfile: UserProfile | null;
  canDelete: boolean;
  onClose: () => void;
  onSave: (profile: UserProfile) => void;
  onDelete?: (profileId: string) => void;
}

export function ProfileEditorModal({
  isOpen,
  editingProfile,
  canDelete,
  onClose,
  onSave,
  onDelete,
}: ProfileEditorModalProps) {
  const { lang, t } = useI18n();

  const [name, setName] = useState('');
  const [avatarId, setAvatarId] = useState<ProfileAvatarId>('crimson');
  const [isKids, setIsKids] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [pinValue, setPinValue] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setConfirmDelete(false);
    setShowPin(false);

    if (editingProfile) {
      setName(editingProfile.name);
      setAvatarId(editingProfile.avatarId);
      setIsKids(editingProfile.isKids);
      setPinEnabled(Boolean(editingProfile.pin && editingProfile.pin.length === 4));
      setPinValue(editingProfile.pin || '');
    } else {
      setName('');
      setAvatarId('cobalt');
      setIsKids(false);
      setPinEnabled(false);
      setPinValue('');
    }
  }, [isOpen, editingProfile]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('profiles.nameRequired'));
      return;
    }

    const cleanPin = pinValue.replace(/\D/g, '').slice(0, 4);
    if (pinEnabled && cleanPin.length !== 4) {
      setError(t('profiles.pinMustBe4'));
      return;
    }

    const now = Date.now();
    const isGuestProfile =
      Boolean(editingProfile?.isGuest) || editingProfile?.id === 'profile_guest';
    const nextProfile: UserProfile = {
      id: editingProfile?.id || `profile_${now}`,
      name: trimmedName,
      avatarId,
      isKids,
      isGuest: isGuestProfile,
      pin: pinEnabled ? cleanPin : undefined,
      hasPin: pinEnabled,
      createdAt: editingProfile?.createdAt || now,
      updatedAt: now,
    };

    onSave(nextProfile);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/82 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-[#12141B] border border-white/10 rounded-2xl shadow-2xl overflow-hidden my-auto"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <h2 className="font-display text-xl font-bold text-white">
            {editingProfile ? t('profiles.editTitle') : t('profiles.createTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-lg hover:bg-white/10 text-[#9CA3B2] hover:text-white flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Avatar Preview + Name */}
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
            <div className="relative shrink-0">
              <ProfileAvatar avatarId={avatarId} name={name || 'IPFLIX'} size="lg" />
              {pinEnabled && (
                <div className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full bg-[#08090D] border border-white/20 flex items-center justify-center text-white shadow">
                  <Lock className="w-3.5 h-3.5" />
                </div>
              )}
            </div>

            <div className="flex-1 w-full space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                  {t('profiles.nameLabel')}
                </label>
                <input
                  type="text"
                  value={name}
                  maxLength={24}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  placeholder={t('profiles.namePlaceholder')}
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-lg bg-[#08090D] border border-white/12 focus:border-[#E50914] focus:outline-none text-base sm:text-sm text-white placeholder:text-[#5B6273]"
                />
              </div>

              {/* Avatar Grid */}
              <div>
                <label className="block text-xs font-medium text-[#9CA3B2] mb-2">
                  {t('profiles.avatarLabel')}
                </label>
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                  {AVATAR_PRESETS.map((preset) => {
                    const selected = avatarId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setAvatarId(preset.id);
                          if (preset.id === 'kids' && !editingProfile) {
                            setIsKids(true);
                          }
                        }}
                        title={lang === 'tr' ? preset.labelTr : preset.labelEn}
                        className={`relative rounded-lg p-0.5 transition-transform ${
                          selected
                            ? 'ring-2 ring-white scale-105'
                            : 'opacity-75 hover:opacity-100 hover:scale-105'
                        }`}
                      >
                        <ProfileAvatar avatarId={preset.id} size="md" className="!w-full !h-auto aspect-square" />
                        {selected && (
                          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white text-black flex items-center justify-center">
                            <Check className="w-3 h-3 stroke-[3]" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Hairline Divider + Kids Mode & PIN Lock */}
          <div className="border-t border-white/[0.08] pt-5 space-y-5">
            {/* Kids Profile Toggle */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">{t('profiles.kidsLabel')}</p>
                <p className="text-xs text-[#9CA3B2] mt-0.5 leading-relaxed">
                  {t('profiles.kidsDesc')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isKids}
                onClick={() => setIsKids((v) => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 mt-0.5 ${
                  isKids ? 'bg-[#E50914]' : 'bg-white/15'
                }`}
              >
                <span
                  className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                    isKids ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* 4-Digit PIN Lock Toggle */}
            <div className="border-t border-white/[0.06] pt-5 space-y-3.5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-white flex items-center gap-2">
                    <Shield className="w-4 h-4 text-[#E50914]" />
                    <span>{t('profiles.pinToggleLabel')}</span>
                  </p>
                  <p className="text-xs text-[#9CA3B2] mt-0.5 leading-relaxed">
                    {t('profiles.pinToggleDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pinEnabled}
                  onClick={() => {
                    setPinEnabled((v) => !v);
                    setError(null);
                  }}
                  className={`relative w-11 h-6 rounded-full transition-colors shrink-0 mt-0.5 ${
                    pinEnabled ? 'bg-[#E50914]' : 'bg-white/15'
                  }`}
                >
                  <span
                    className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                      pinEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {pinEnabled && (
                <div className="pl-0 sm:pl-6 max-w-xs">
                  <label className="block text-xs font-medium text-[#9CA3B2] mb-1.5">
                    {t('profiles.pinInputLabel')}
                  </label>
                  <div className="relative">
                    <input
                      type={showPin ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={4}
                      value={pinValue}
                      onChange={(e) => {
                        setPinValue(e.target.value.replace(/\D/g, '').slice(0, 4));
                        setError(null);
                      }}
                      placeholder={t('profiles.pinPlaceholder')}
                      className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[#08090D] border border-white/15 focus:border-[#E50914] focus:outline-none text-base tracking-[0.45em] font-mono tabular-nums text-white"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPin((s) => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9CA3B2] hover:text-white"
                      aria-label={showPin ? t('profiles.hidePin') : t('profiles.showPin')}
                    >
                      {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="text-xs text-[#FF6B73] font-medium">{error}</p>
          )}

          {/* Delete Confirmation Bar (no window.confirm) */}
          {confirmDelete && editingProfile && onDelete && (
            <div className="p-3.5 rounded-xl bg-[#E50914]/12 border border-[#E50914]/35 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-red-100">
                {t('profiles.deleteConfirm', { name: editingProfile.name })}
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDelete(editingProfile.id);
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs text-white font-semibold"
                >
                  {t('profiles.deleteProfile')}
                </button>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            {editingProfile && canDelete && onDelete && !confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium text-[#9CA3B2] hover:text-[#FF6B73] hover:bg-[#E50914]/10 inline-flex items-center gap-1.5 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                <span>{t('profiles.deleteProfile')}</span>
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2.5 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-sm font-medium text-white transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-sm font-semibold text-white transition-colors"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================================
// 4-Digit Netflix-Style PIN Verification Modal
// ============================================================================
interface PinPromptModalProps {
  profile: UserProfile | null;
  onClose: () => void;
  onUnlocked: (profile: UserProfile) => void;
}

export function PinPromptModal({ profile, onClose, onUnlocked }: PinPromptModalProps) {
  const { t } = useI18n();
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [wrongPin, setWrongPin] = useState(false);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (profile) {
      setDigits(['', '', '', '']);
      setWrongPin(false);
      setTimeout(() => inputsRef.current[0]?.focus(), 40);
    }
  }, [profile]);

  if (!profile) return null;

  const verifyCode = (next: string[]) => {
    const code = next.join('');
    if (code.length < 4) return;
    if (code === profile.pin) {
      onUnlocked(profile);
    } else {
      setWrongPin(true);
      setDigits(['', '', '', '']);
      setTimeout(() => inputsRef.current[0]?.focus(), 50);
    }
  };

  const handleChange = (index: number, raw: string) => {
    setWrongPin(false);
    const cleaned = raw.replace(/\D/g, '');
    if (!cleaned) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
      return;
    }

    // Handle pasting all 4 digits at once
    if (cleaned.length > 1) {
      const next = ['', '', '', ''];
      for (let i = 0; i < 4; i++) {
        next[i] = cleaned[i] || '';
      }
      setDigits(next);
      const focusIdx = Math.min(3, cleaned.length);
      inputsRef.current[focusIdx]?.focus();
      verifyCode(next);
      return;
    }

    const next = [...digits];
    next[index] = cleaned[0];
    setDigits(next);
    if (index < 3) {
      inputsRef.current[index + 1]?.focus();
    }
    verifyCode(next);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[75] bg-black/88 backdrop-blur-md flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#12141B] border border-white/10 rounded-2xl p-7 text-center shadow-2xl relative"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute top-4 right-4 w-9 h-9 rounded-lg hover:bg-white/10 text-[#9CA3B2] hover:text-white flex items-center justify-center transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex flex-col items-center">
          <div className="relative mb-4">
            <ProfileAvatar avatarId={profile.avatarId} name={profile.name} size="md" className="!w-16 !h-16" />
            <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-[#E50914] text-white flex items-center justify-center shadow">
              <Lock className="w-3.5 h-3.5" />
            </span>
          </div>

          <h2 className="font-display text-xl font-bold text-white">
            {t('profiles.pinModalTitle')}
          </h2>
          <p className="text-sm text-[#9CA3B2] mt-1.5">
            {t('profiles.pinModalDesc', { name: profile.name })}
          </p>

          {/* 4-Box PIN Entry */}
          <div className="flex items-center justify-center gap-3 mt-6">
            {digits.map((val, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  inputsRef.current[idx] = el;
                }}
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={val}
                onChange={(e) => handleChange(idx, e.target.value)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                aria-label={`PIN ${idx + 1}`}
                className={`w-14 h-16 rounded-xl bg-[#08090D] border text-center text-2xl font-mono tabular-nums text-white focus:outline-none transition-colors ${
                  wrongPin
                    ? 'border-[#E50914] ring-1 ring-[#E50914]/50'
                    : 'border-white/15 focus:border-white'
                }`}
              />
            ))}
          </div>

          {wrongPin ? (
            <p className="text-xs text-[#FF6B73] font-medium mt-4">
              {t('profiles.pinWrong')}
            </p>
          ) : (
            <p className="text-xs text-[#666E80] mt-4">
              {t('profiles.pinForgotHint')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Full-Screen Netflix "Kim İzliyor?" Profile Gate
// ============================================================================
interface ProfileGateProps {
  profiles: UserProfile[];
  activeProfileId: string;
  initialManageMode?: boolean;
  canDismiss?: boolean;
  vaultLocked?: boolean;
  vaultError?: string | null;
  onRetryVault?: () => Promise<void> | void;
  onResetLockedVault?: () => Promise<void> | void;
  onDismiss?: () => void;
  onSelectProfile: (profile: UserProfile) => void;
  onSaveProfile: (profile: UserProfile) => void;
  onDeleteProfile: (profileId: string) => void;
}

export function ProfileGate({
  profiles,
  activeProfileId,
  initialManageMode = false,
  canDismiss = false,
  vaultLocked = false,
  vaultError = null,
  onRetryVault,
  onResetLockedVault,
  onDismiss,
  onSelectProfile,
  onSaveProfile,
  onDeleteProfile,
}: ProfileGateProps) {
  const { lang, setLang, t } = useI18n();
  const [manageMode, setManageMode] = useState(initialManageMode);
  const [editingProfile, setEditingProfile] = useState<UserProfile | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pinTarget, setPinTarget] = useState<UserProfile | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const [confirmSafeReset, setConfirmSafeReset] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const nonGuestCount = profiles.filter((p) => !p.isGuest).length;

  useEffect(() => {
    setManageMode(initialManageMode);
  }, [initialManageMode]);

  useEffect(() => {
    if (!vaultLocked) {
      setPinNotice(null);
      setConfirmSafeReset(false);
    }
  }, [vaultLocked]);

  const handleTileClick = (profile: UserProfile) => {
    setPinNotice(null);
    const hasUnreadablePin = Boolean(profile.hasPin && (!profile.pin || profile.pin.length !== 4));
    if (hasUnreadablePin) {
      setPinNotice(t('storage.vaultPinUnavailable'));
      return;
    }
    if (manageMode) {
      setEditingProfile(profile);
      setEditorOpen(true);
      return;
    }
    if (profile.pin && profile.pin.length === 4) {
      setPinTarget(profile);
      return;
    }
    onSelectProfile(profile);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-[#08090D] text-white flex flex-col overflow-y-auto overflow-x-clip safe-area-top safe-area-bottom">
      {/* Subtle radial studio spotlight */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(229,9,20,0.09),transparent_58%)]" />

      {/* Top Bar */}
      <header className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 h-16 sm:h-20 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-4">
          <BrandMark size="md" />
          <span className="hidden md:inline text-[10px] font-semibold tracking-[0.28em] text-white/40 uppercase border-l border-white/10 pl-4">
            {t('app.slogan')}
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="inline-flex items-center p-1 rounded-lg bg-[#12141B] border border-white/10">
            <button
              type="button"
              onClick={() => setLang('tr')}
              className={`min-h-[34px] px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                lang === 'tr' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
              }`}
            >
              TR
            </button>
            <button
              type="button"
              onClick={() => setLang('en')}
              className={`min-h-[34px] px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                lang === 'en' ? 'bg-[#E50914] text-white' : 'text-[#9CA3B2] hover:text-white'
              }`}
            >
              EN
            </button>
          </div>

          {canDismiss && onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t('common.close')}
              className="w-11 h-11 sm:w-9 sm:h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[#9CA3B2] hover:text-white flex items-center justify-center transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* Main Centered Profiles Stage */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-8 sm:py-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="text-center"
        >
          <h1 className="font-display text-2xl sm:text-5xl font-bold tracking-tight text-white">
            {manageMode ? t('profiles.manageTitle') : t('profiles.whoWatching')}
          </h1>
          {manageMode && (
            <p className="text-xs sm:text-sm text-[#9CA3B2] mt-2.5 max-w-md mx-auto">
              {t('profiles.manageSubtitle')}
            </p>
          )}
        </motion.div>

        {vaultLocked && (
          <div className="mt-6 max-w-2xl w-full rounded-xl bg-amber-500/10 border border-amber-500/35 p-4 space-y-3 text-left">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0">
                <p className="text-sm font-bold text-white">{t('storage.vaultLockedTitle')}</p>
                <p className="text-xs text-amber-100/85 leading-relaxed break-words">
                  {vaultError || t('storage.vaultPinUnavailable')}
                </p>
              </div>
            </div>
            {(onRetryVault || onResetLockedVault) && (
              <div className="flex flex-wrap items-center gap-2 pl-8">
                {onRetryVault && (
                  <button
                    type="button"
                    disabled={recovering}
                    onClick={async () => {
                      setRecovering(true);
                      try {
                        await onRetryVault();
                      } finally {
                        setRecovering(false);
                      }
                    }}
                    className="px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white inline-flex items-center gap-1.5 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t('storage.vaultRetryBtn')}</span>
                  </button>
                )}
                {onResetLockedVault && !confirmSafeReset && (
                  <button
                    type="button"
                    disabled={recovering}
                    onClick={() => setConfirmSafeReset(true)}
                    className="px-3.5 py-2 rounded-lg bg-[#E50914]/20 hover:bg-[#E50914] border border-[#E50914]/40 text-xs font-semibold text-white transition-colors"
                  >
                    {t('storage.vaultResetSafeBtn')}
                  </button>
                )}
                {onResetLockedVault && confirmSafeReset && (
                  <>
                    <button
                      type="button"
                      disabled={recovering}
                      onClick={() => setConfirmSafeReset(false)}
                      className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-white"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={recovering}
                      onClick={async () => {
                        setRecovering(true);
                        try {
                          await onResetLockedVault();
                          setConfirmSafeReset(false);
                        } finally {
                          setRecovering(false);
                        }
                      }}
                      className="px-3.5 py-2 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-xs font-semibold text-white"
                    >
                      {t('common.confirm')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {pinNotice && (
          <div className="mt-5 max-w-xl w-full rounded-xl bg-[#E50914]/15 border border-[#E50914]/40 px-4 py-3 text-xs text-red-100 text-center">
            {pinNotice}
          </div>
        )}

        <div className="mt-8 sm:mt-12 grid grid-cols-2 sm:flex sm:flex-wrap items-start justify-items-center justify-center gap-5 sm:gap-9 max-w-4xl w-full sm:w-auto">
          {profiles.map((profile, idx) => {
            const isLocked = Boolean((profile.pin && profile.pin.length === 4) || profile.hasPin);
            const isCurrent = profile.id === activeProfileId;
            return (
              <motion.button
                key={profile.id}
                type="button"
                data-focusable="true"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, delay: Math.min(idx * 0.06, 0.28), ease: 'easeOut' }}
                onClick={() => handleTileClick(profile)}
                className="group flex flex-col items-center gap-2.5 sm:gap-3 w-full max-w-[136px] sm:w-36 sm:max-w-none focus:outline-none active:scale-[0.98] transition-transform"
              >
                <div
                  className={`relative rounded-xl transition-transform duration-200 ease-out group-hover:scale-105 group-focus-visible:scale-105 ${
                    isCurrent && !manageMode
                      ? 'ring-2 ring-white/45 group-hover:ring-[#E50914] group-focus-visible:ring-[#E50914] group-focus-visible:shadow-[0_0_28px_-4px_rgba(229,9,20,0.55)]'
                      : 'ring-2 ring-transparent group-hover:ring-white/80 group-focus-visible:ring-[#E50914] group-focus-visible:shadow-[0_0_28px_-4px_rgba(229,9,20,0.55)]'
                  }`}
                >
                  <ProfileAvatar
                    avatarId={profile.avatarId}
                    name={profile.name}
                    size="xl"
                    className={manageMode ? 'opacity-65' : ''}
                  />

                  {manageMode && (
                    <div className="absolute inset-0 rounded-xl bg-black/45 flex items-center justify-center">
                      <span className="w-11 h-11 rounded-full bg-black/75 border border-white/30 flex items-center justify-center text-white group-hover:scale-110 transition-transform">
                        <Pencil className="w-5 h-5" />
                      </span>
                    </div>
                  )}

                  {isLocked && !manageMode && (
                    <div
                      title={t('common.locked')}
                      className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-black/75 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white"
                    >
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                  )}
                </div>

                <div className="text-center w-full space-y-0.5">
                  <p className="text-sm sm:text-base font-medium text-[#B8BFCC] group-hover:text-white group-focus-visible:text-white truncate transition-colors">
                    {profile.name}
                  </p>
                  {(profile.isKids || profile.isGuest || isLocked) && (
                    <p className="text-[11px] font-medium text-[#6E7688] tracking-wide">
                      {[
                        profile.isGuest ? t('common.guest') : null,
                        profile.isKids ? t('common.kids') : null,
                        isLocked ? t('common.locked') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              </motion.button>
            );
          })}

          {/* Add New Profile Tile */}
          {nonGuestCount < MAX_PROFILES && (
            <motion.button
              type="button"
              data-focusable="true"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, delay: Math.min(profiles.length * 0.06, 0.3), ease: 'easeOut' }}
              onClick={() => {
                setEditingProfile(null);
                setEditorOpen(true);
              }}
              className="group flex flex-col items-center gap-2.5 sm:gap-3 w-full max-w-[136px] sm:w-36 sm:max-w-none focus:outline-none active:scale-[0.98] transition-transform"
            >
              <div className="w-28 h-28 sm:w-36 sm:h-36 rounded-xl bg-[#12141B] border border-dashed border-white/20 group-hover:border-white/75 group-focus-visible:border-[#E50914] group-focus-visible:ring-2 group-focus-visible:ring-[#E50914] group-hover:bg-white/[0.06] flex items-center justify-center transition-transform duration-200 group-hover:scale-105 group-focus-visible:scale-105">
                <Plus className="w-10 h-10 text-[#9CA3B2] group-hover:text-white group-focus-visible:text-white transition-colors" />
              </div>
              <p className="text-sm sm:text-base font-medium text-[#9CA3B2] group-hover:text-white group-focus-visible:text-white transition-colors">
                {t('profiles.addProfile')}
              </p>
            </motion.button>
          )}
        </div>

        {/* Manage Profiles Toggle Button */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.22 }}
          className="mt-10 sm:mt-14"
        >
          <button
            type="button"
            data-focusable="true"
            onClick={() => setManageMode((v) => !v)}
            className={`min-h-[44px] px-7 py-2.5 rounded-lg text-sm font-semibold tracking-wide transition-colors active:scale-[0.98] ${
              manageMode
                ? 'bg-white text-black hover:bg-white/90'
                : 'border border-white/25 text-[#B8BFCC] hover:border-white hover:text-white'
            }`}
          >
            {manageMode ? t('profiles.doneManaging') : t('profiles.manageBtn')}
          </button>
        </motion.div>
      </main>

      {/* Modals */}
      <ProfileEditorModal
        isOpen={editorOpen}
        editingProfile={editingProfile}
        canDelete={!editingProfile?.isGuest && nonGuestCount > 1}
        onClose={() => setEditorOpen(false)}
        onSave={onSaveProfile}
        onDelete={onDeleteProfile}
      />

      <PinPromptModal
        profile={pinTarget}
        onClose={() => setPinTarget(null)}
        onUnlocked={(unlockedProfile) => {
          setPinTarget(null);
          onSelectProfile(unlockedProfile);
        }}
      />
    </div>
  );
}

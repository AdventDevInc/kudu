import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Rocket, Check, ChevronRight, ChevronLeft, Globe } from 'lucide-react'
import { LANGUAGES } from '@/lib/languages'
import logoSrc from '@/assets/logo.png'

interface OnboardingProps {
  onComplete: () => void
}

interface OnboardingSettings {
  runAtStartup: boolean
  minimizeToTray: boolean
  scheduledClean: boolean
}

const TOTAL_STEPS = 4

export function Onboarding({ onComplete }: OnboardingProps) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [settings, setSettings] = useState<OnboardingSettings>({
    runAtStartup: true,
    minimizeToTray: true,
    scheduledClean: true
  })

  const applyAndFinish = async () => {
    try {
      const settingsPayload: Record<string, any> = {
        runAtStartup: settings.runAtStartup,
        minimizeToTray: settings.minimizeToTray
      }
      if (settings.scheduledClean) {
        settingsPayload.schedule = { enabled: true, frequency: 'weekly', day: 1, hour: 9 }
      }
      await window.kudu?.settingsSet?.(settingsPayload)
      await window.kudu?.applyStartup?.(settings.runAtStartup).catch(() => {})
      window.kudu?.applyTray?.(settings.minimizeToTray)
    } catch {
      // Best-effort
    }
    onComplete()
    navigate('/')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="relative w-full max-w-lg rounded-2xl p-8"
        style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <AnimatePresence mode="wait">
          {step === 0 && <LanguageStep key="language" onNext={() => setStep(1)} />}
          {step === 1 && <WelcomeStep key="welcome" onBack={() => setStep(0)} onNext={() => setStep(2)} />}
          {step === 2 && (
            <SettingsStep
              key="settings"
              settings={settings}
              onChange={setSettings}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <FinishStep
              key="finish"
              scheduledClean={settings.scheduledClean}
              onBack={() => setStep(2)}
              onFinish={applyAndFinish}
            />
          )}
        </AnimatePresence>

        {/* Step dots */}
        <div className="mt-8 flex justify-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-all duration-300"
              style={{
                width: i === step ? 24 : 8,
                background: i === step ? '#f59e0b' : 'rgba(255,255,255,0.1)'
              }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  )
}

function StepWrapper({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  )
}

function LanguageStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation('onboarding')
  const [selected, setSelected] = useState(i18next.language)

  const handleSelect = (code: string) => {
    setSelected(code)
    i18next.changeLanguage(code)
    window.kudu?.settingsSet?.({ language: code }).catch(() => {})
  }

  return (
    <StepWrapper>
      <div className="flex flex-col items-center text-center">
        <div
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{ background: 'rgba(245,158,11,0.1)' }}
        >
          <Globe className="h-8 w-8" style={{ color: '#f59e0b' }} strokeWidth={1.5} />
        </div>
        <h2 className="mb-1 text-[18px] font-bold text-zinc-100">{t('chooseLanguageTitle')}</h2>
        <p className="mb-5 text-[13px] text-zinc-500">{t('chooseLanguageDescription')}</p>

        <div className="mb-6 grid max-h-[240px] w-full grid-cols-2 gap-1.5 overflow-y-auto rounded-xl p-1">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => handleSelect(lang.code)}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
              style={{
                background: selected === lang.code ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.02)',
                border: selected === lang.code ? '1px solid rgba(245,158,11,0.3)' : '1px solid transparent',
                color: selected === lang.code ? '#f59e0b' : '#a1a1aa'
              }}
            >
              <span className="font-medium">{lang.nativeName}</span>
              {selected === lang.code && <Check className="ml-auto h-3.5 w-3.5 shrink-0" style={{ color: '#f59e0b' }} strokeWidth={2.5} />}
            </button>
          ))}
        </div>

        <button
          onClick={onNext}
          className="flex items-center gap-2 rounded-xl px-8 py-3 text-[14px] font-semibold text-zinc-900 transition-opacity hover:opacity-90"
          style={{ background: '#f59e0b' }}
        >
          {t('continue')} <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </StepWrapper>
  )
}

function WelcomeStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation('onboarding')
  return (
    <StepWrapper>
      <div className="flex flex-col items-center text-center">
        <img src={logoSrc} alt="Kudu" className="mb-5 h-20 w-20 rounded-2xl" />
        <h2 className="mb-2 text-[22px] font-bold text-zinc-100">{t('welcomeTitle')}</h2>
        <p className="mb-2 text-[13px] leading-relaxed text-zinc-400">
          {t('welcomeDescription')}
        </p>
        <div className="mb-6 mt-4 flex gap-4">
          <Feature icon={Sparkles} label={t('featureSmartCleaning')} />
          <Feature icon={Rocket} label={t('featureFasterBoot')} />
          <Feature icon={Check} label={t('featureSafeSecure')} />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-500 transition-colors"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Globe className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onNext}
            className="flex items-center gap-2 rounded-xl px-8 py-3 text-[14px] font-semibold text-zinc-900 transition-opacity hover:opacity-90"
            style={{ background: '#f59e0b' }}
          >
            {t('getStarted')} <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </StepWrapper>
  )
}

function Feature({ icon: Icon, label }: { icon: typeof Sparkles; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'rgba(245,158,11,0.1)' }}>
        <Icon className="h-4.5 w-4.5" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
      </div>
      <span className="text-[11px] font-medium text-zinc-500">{label}</span>
    </div>
  )
}

function SettingsStep({
  settings,
  onChange,
  onBack,
  onNext
}: {
  settings: OnboardingSettings
  onChange: (s: OnboardingSettings) => void
  onBack: () => void
  onNext: () => void
}) {
  const { t } = useTranslation('onboarding')
  return (
    <StepWrapper>
      <div>
        <h2 className="mb-1 text-[18px] font-bold text-zinc-100">{t('recommendedSetupTitle')}</h2>
        <p className="mb-6 text-[13px] text-zinc-500">
          {t('recommendedSetupDescription')}
        </p>

        <div className="space-y-1">
          <SettingRow
            label={t('runAtStartupLabel')}
            desc={t('runAtStartupDescription')}
            checked={settings.runAtStartup}
            onChange={(v) => onChange({ ...settings, runAtStartup: v })}
          />
          <SettingRow
            label={t('minimizeToTrayLabel')}
            desc={t('minimizeToTrayDescription')}
            checked={settings.minimizeToTray}
            onChange={(v) => onChange({ ...settings, minimizeToTray: v })}
          />
          <SettingRow
            label={t('weeklyAutoCleanLabel')}
            desc={t('weeklyAutoCleanDescription')}
            checked={settings.scheduledClean}
            onChange={(v) => onChange({ ...settings, scheduledClean: v })}
            last
          />
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-500 transition-colors"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> {t('back')}
          </button>
          <button
            onClick={onNext}
            className="flex items-center gap-2 rounded-xl px-6 py-2.5 text-[14px] font-semibold text-zinc-900 transition-opacity hover:opacity-90"
            style={{ background: '#f59e0b' }}
          >
            {t('continue')} <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </StepWrapper>
  )
}

function SettingRow({
  label,
  desc,
  checked,
  onChange,
  last
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  last?: boolean
}) {
  return (
    <div
      className="flex items-center justify-between rounded-xl px-4 py-3.5"
      style={{
        background: 'rgba(255,255,255,0.02)',
        ...(last ? {} : { marginBottom: 4 })
      }}
    >
      <div className="mr-4">
        <p className="text-[13px] font-medium text-zinc-300">{label}</p>
        <p className="mt-0.5 text-[12px]" style={{ color: '#52525e' }}>{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
      style={{ background: checked ? '#f59e0b' : 'rgba(255,255,255,0.08)' }}
    >
      <div
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}

function FinishStep({
  scheduledClean,
  onBack,
  onFinish
}: {
  scheduledClean: boolean
  onBack: () => void
  onFinish: () => void
}) {
  const { t } = useTranslation('onboarding')
  return (
    <StepWrapper>
      <div className="flex flex-col items-center text-center">
        <div
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{ background: 'rgba(34,197,94,0.1)' }}
        >
          <Check className="h-8 w-8" style={{ color: '#22c55e' }} strokeWidth={1.8} />
        </div>
        <h2 className="mb-2 text-[18px] font-bold text-zinc-100">{t('allSetTitle')}</h2>
        <p className="mb-1 text-[13px] leading-relaxed text-zinc-400">
          {t('allSetDescription')}
        </p>
        {scheduledClean && (
          <p className="text-[12px]" style={{ color: '#f59e0b' }}>
            {t('firstScanScheduled')}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-500 transition-colors"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> {t('back')}
          </button>
          <button
            onClick={onFinish}
            className="flex items-center gap-2 rounded-xl px-8 py-3 text-[14px] font-semibold text-zinc-900 transition-opacity hover:opacity-90"
            style={{ background: '#f59e0b' }}
          >
            {t('startCleaning')} <Rocket className="h-4 w-4" />
          </button>
        </div>
      </div>
    </StepWrapper>
  )
}

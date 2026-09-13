import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  HardDrive,
  RotateCcw,
  Shield,
  Zap
} from 'lucide-react'
import { usePlatform } from '@/hooks/usePlatform'
import { pageExperiences } from '@/components/layout/page-experiences'
import { getGoalTools, type DashboardGoal } from './simple-dashboard-tools'
import './simple-dashboard.css'
import { DashboardCloud } from './DashboardCloud'

const goals = [
  { id: 'space', icon: HardDrive },
  { id: 'speed', icon: Zap },
  { id: 'protection', icon: Shield }
] as const

export function SimpleDashboard({
  onAdvanced,
  switching
}: {
  onAdvanced: () => void
  switching: boolean
}) {
  const { t } = useTranslation('experience')
  const platform = usePlatform()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<DashboardGoal | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (selected) heading.current?.focus({ preventScroll: true })
  }, [selected])
  const selectedTools = selected ? getGoalTools(selected, platform) : []

  return (
    <div className="simple-dashboard">
      <header className="simple-dashboard-heading">
        <span className="pulse-eyebrow">{t('simple.eyebrow')}</span>
        <h1>{t('simple.title')}</h1>
        <p>{t('simple.description')}</p>
      </header>
      <div className="simple-goals" aria-label={t('simple.chooseGoal')}>
        {goals.map(({ id, icon: Icon }) => (
          <button
            className="simple-goal"
            data-goal={id}
            key={id}
            aria-expanded={selected === id}
            aria-controls={selected ? 'simple-goal-tools' : undefined}
            onClick={() => setSelected(id)}
          >
            <span className="simple-goal-top">
              <span className="simple-goal-icon">
                <Icon size={25} strokeWidth={1.65} />
              </span>
              <ArrowUpRight size={22} />
            </span>
            <h2>{t(`simple.goals.${id}.title`)}</h2>
            <p>{t(`simple.goals.${id}.description`)}</p>
            <span className="simple-goal-count">
              {t(`simple.goals.${id}.count`, { count: getGoalTools(id, platform).length })}
            </span>
          </button>
        ))}
      </div>
      {selected ? (
        <section
          className="simple-tool-panel"
          id="simple-goal-tools"
          aria-labelledby="simple-tools-heading"
        >
          <div className="simple-tool-heading">
            <div>
              <span className="pulse-eyebrow">{t('simple.yourNextStep')}</span>
              <h2 ref={heading} tabIndex={-1} id="simple-tools-heading">
                {t(`simple.goals.${selected}.heading`)}
              </h2>
              <p>{t(`simple.goals.${selected}.guidance`)}</p>
            </div>
            <span>{t('simple.chooseTool')}</span>
          </div>
          <div className="simple-tool-list">
            {selectedTools.map((tool, index) => {
              const experience = pageExperiences[tool.path]
              const Icon = experience.icon
              return (
                <button
                  key={tool.path}
                  className={`simple-tool ${index === 0 ? 'suggested' : ''}`}
                  onClick={() => navigate(tool.path)}
                >
                  <span className="simple-tool-icon">
                    <Icon size={20} strokeWidth={1.7} />
                  </span>
                  <span className="simple-tool-copy">
                    {index === 0 && (
                      <small className="simple-start-label">{t('simple.startHere')}</small>
                    )}
                    <strong>{t(tool.titleKey)}</strong>
                    <span>{t(`routes.${experience.key}`)}</span>
                    {tool.tier && (
                      <small className="simple-tier">{t(`simple.cloud.${tool.tier}`)}</small>
                    )}
                  </span>
                  <ArrowRight size={17} />
                </button>
              )
            })}
          </div>
        </section>
      ) : (
        <div className="simple-support">
          <button onClick={() => navigate('/schedules')}>
            <CalendarClock size={23} strokeWidth={1.6} />
            <span>
              <strong>{t('simple.routineTitle')}</strong>
              <small>{t('simple.routineDescription')}</small>
            </span>
            <ArrowUpRight size={18} />
          </button>
          <DashboardCloud variant="compact">
            <button onClick={() => navigate('/recovery')}>
              <RotateCcw size={23} strokeWidth={1.6} />
              <span>
                <strong>{t('simple.recoveryTitle')}</strong>
                <small>{t('simple.recoveryDescription')}</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </DashboardCloud>
        </div>
      )}
      <footer className="simple-dashboard-footer">
        <span>
          <Shield size={16} />
          {t('simple.reviewFirst')}
        </span>
        <button disabled={switching} onClick={onAdvanced}>
          {t('simple.advancedPrompt')}
          <ArrowRight size={16} />
        </button>
      </footer>
    </div>
  )
}

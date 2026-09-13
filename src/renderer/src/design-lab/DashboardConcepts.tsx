import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Download,
  Gamepad2,
  HardDrive,
  HeartPulse,
  History,
  House,
  LayoutGrid,
  Leaf,
  MemoryStick,
  Monitor,
  Package,
  Settings2,
  Shield,
  Sparkles,
  Sun,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'
import logo from '../assets/logo.png'

const concepts = [
  {
    name: 'Refined',
    note: 'Familiar, thoughtfully elevated',
    description:
      'A clearer daily overview. Quiet surfaces, purposeful amber, and your next action right where you need it.'
  },
  {
    name: 'Focus',
    note: 'Less noise. More breathing room.',
    description: 'One clear next step, a calm health summary, and the essentials at a glance.'
  },
  {
    name: 'Pulse',
    note: 'A closer connection to your PC',
    description:
      'Performance takes the lead, with readable telemetry and useful context instead of a wall of numbers.'
  },
  {
    name: 'Daylight',
    note: 'A lighter kind of clean',
    description:
      'Warm whites, crisp typography, and the same Kudu amber. A fresh, comfortable everyday workspace.'
  },
  {
    name: 'Canvas',
    note: 'Small details. Big personality.',
    description:
      'An expressive collection of useful widgets. Tactile cards, strong hierarchy, and a little more character.'
  }
]

const nav: [LucideIcon, string][] = [
  [House, 'Home'],
  [Sparkles, 'Clean up'],
  [Shield, 'Protection'],
  [Activity, 'Performance'],
  [Package, 'Applications'],
  [HardDrive, 'Storage'],
  [Gamepad2, 'Game Mode'],
  [History, 'Activity']
]
const cleanup = [
  { name: 'System temporary files', size: 2.4 },
  { name: 'Browser cache', size: 1.2 },
  { name: 'Application cache', size: 0.6 }
]

function IconTile({ icon: Icon, tone = '' }: { icon: LucideIcon; tone?: string }) {
  return (
    <span className={`icon-tile ${tone}`}>
      <Icon size={20} strokeWidth={1.65} />
    </span>
  )
}

function Action({
  children,
  onClick,
  secondary = false
}: {
  children: ReactNode
  onClick: () => void
  secondary?: boolean
}) {
  return (
    <button className={`action ${secondary ? 'secondary' : ''}`} onClick={onClick}>
      {children}
      <ArrowRight size={16} />
    </button>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>
}

function Ring({ score = 86, large = false }: { score?: number; large?: boolean }) {
  return (
    <div
      className={`health-ring ${large ? 'large' : ''}`}
      role="img"
      aria-label={`Sample system health: ${score} out of 100, looking good`}
    >
      <svg viewBox="0 0 180 180" aria-hidden="true">
        <circle className="ring-track" cx="90" cy="90" r="76" />
        <circle
          className="ring-value"
          cx="90"
          cy="90"
          r="76"
          strokeDasharray={`${score * 4.775} 477.5`}
        />
      </svg>
      <div>
        <strong>
          {score}
          <small>/100</small>
        </strong>
        <span>Looking good</span>
      </div>
    </div>
  )
}

function Sparkline({ color = 'var(--amber)', variant = 0 }: { color?: string; variant?: number }) {
  const paths = [
    '0,43 14,39 28,45 42,26 56,31 70,12 84,23 98,19 112,36 126,25 140,27 154,14 168,21 182,11 196,17 210,8',
    '0,30 14,27 28,28 42,32 56,23 70,24 84,19 98,22 112,18 126,21 140,14 154,18 168,13 182,17 196,13 210,15'
  ]
  return (
    <svg className="sparkline" viewBox="0 0 210 55" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={paths[variant % 2]}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  unit,
  detail,
  variant = 0
}: {
  icon: LucideIcon
  label: string
  value: string
  unit: string
  detail: string
  variant?: number
}) {
  return (
    <div className="metric panel">
      <div className="card-label">
        <Icon size={16} />
        <span>{label}</span>
        <span className="live-dot" />
      </div>
      <div className="metric-number">
        {value}
        <small>{unit}</small>
      </div>
      <Sparkline variant={variant} color={variant ? 'var(--mint)' : 'var(--amber)'} />
      <p>{detail}</p>
    </div>
  )
}

function Storage({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="panel storage">
      <div className="section-heading">
        <h3>Storage</h3>
        <button className="icon-button" aria-label="View storage details" onClick={onOpen}>
          <ArrowUpRight size={17} />
        </button>
      </div>
      <div className="storage-label">
        <IconTile icon={HardDrive} />
        <div>
          <b>Windows (C:)</b>
          <span>512 GB · Solid state drive</span>
        </div>
        <strong>
          64<small>%</small>
        </strong>
      </div>
      <div className="storage-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="storage-legend">
        <span>
          <i />
          328 GB used
        </span>
        <span>184 GB free</span>
      </div>
    </section>
  )
}

function Tasks({ open, compact = false }: { open: (name: string) => void; compact?: boolean }) {
  return (
    <section className={`panel tasks ${compact ? 'compact' : ''}`}>
      <div className="section-heading">
        <h3>A little attention goes a long way</h3>
        <span className="count">2</span>
      </div>
      <button className="task-row" onClick={() => open('Application updates')}>
        <IconTile icon={Download} tone="blue" />
        <span>
          <b>3 apps have updates</b>
          <small>Keep your everyday essentials current</small>
        </span>
        <ChevronRight size={17} />
      </button>
      <button className="task-row" onClick={() => open('Startup apps')}>
        <IconTile icon={Zap} tone="amber" />
        <span>
          <b>Make room for a faster start</b>
          <small>2 high-impact apps launch with Windows</small>
        </span>
        <ChevronRight size={17} />
      </button>
    </section>
  )
}

function Recent({ open }: { open: (name: string) => void }) {
  return (
    <section className="panel recent">
      <div className="section-heading">
        <h3>Recently taken care of</h3>
        <button className="text-button" onClick={() => open('Activity')}>
          All activity <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="activity-row">
        <span className="activity-icon">
          <Sparkles size={16} />
        </span>
        <div>
          <b>A little lighter. A lot tidier.</b>
          <small>System cleanup · 1,248 files removed</small>
        </div>
        <div className="activity-result">
          <b>2.8 GB</b>
          <small>Today, 09:41</small>
        </div>
      </div>
      <div className="activity-row">
        <span className="activity-icon">
          <Shield size={16} />
        </span>
        <div>
          <b>No threats found</b>
          <small>Quick scan · 18,420 files checked</small>
        </div>
        <div className="activity-result">
          <b className="mint-text">All clear</b>
          <small>Today, 09:38</small>
        </div>
      </div>
    </section>
  )
}

function GameCard({ game, toggle }: { game: boolean; toggle: () => void }) {
  return (
    <section className={`panel game-card ${game ? 'enabled' : ''}`}>
      <IconTile icon={Gamepad2} />
      <div>
        <h3>A little more play.</h3>
        <p>{game ? 'Game Mode is on in this preview' : 'Give your games room to run.'}</p>
      </div>
      <button
        className="switch"
        role="switch"
        aria-label="Game Mode preview"
        aria-checked={game}
        onClick={toggle}
      >
        <span />
      </button>
    </section>
  )
}

function PerformanceChart({ period }: { period: string }) {
  const values =
    period === '1 hour'
      ? [
          30, 32, 22, 35, 24, 30, 53, 42, 48, 30, 37, 28, 44, 31, 52, 43, 39, 58, 46, 31, 41, 33,
          25, 36, 12
        ]
      : [
          20, 28, 24, 39, 30, 22, 32, 48, 33, 35, 52, 43, 34, 49, 62, 41, 33, 48, 35, 31, 22, 29,
          25, 30, 12
        ]
  const line = values.map((v, i) => `${i * 30},${150 - v * 1.35}`).join(' ')
  return (
    <div className="performance-chart">
      <div className="chart-scale">
        <span>100%</span>
        <span>50%</span>
        <span>0%</span>
      </div>
      <svg
        viewBox="0 0 720 170"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Sample CPU utilization over ${period}`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#efa943" stopOpacity=".24" />
            <stop offset="100%" stopColor="#efa943" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[15, 80, 150].map((y) => (
          <line key={y} x1="0" x2="720" y1={y} y2={y} className="chart-grid" />
        ))}
        <polygon points={`0,170 ${line} 720,170`} fill="url(#chart-fill)" />
        <polyline
          points={line}
          fill="none"
          stroke="var(--amber)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <polyline
          points="0,125 60,122 120,124 180,118 240,120 300,116 360,119 420,115 480,118 540,114 600,116 660,112 720,115"
          fill="none"
          stroke="var(--mint)"
          strokeWidth="2"
        />
      </svg>
      <div className="chart-times">
        <span>{period === '1 hour' ? '60 minutes ago' : '24 hours ago'}</span>
        <span>Now</span>
      </div>
    </div>
  )
}

export function DashboardConcepts() {
  const initial = Number(new URLSearchParams(window.location.search).get('v'))
  const [version, setVersion] = useState(initial >= 1 && initial <= 5 ? initial : 1)
  const [modal, setModal] = useState<string | null>(null)
  const [selected, setSelected] = useState([true, true, true])
  const [cleaned, setCleaned] = useState(false)
  const [game, setGame] = useState(false)
  const [period, setPeriod] = useState('1 hour')
  const dialog = useRef<HTMLDialogElement>(null)
  const concept = concepts[version - 1]
  const open = (name: string) => setModal(name)
  const scan = () => {
    setCleaned(false)
    setSelected([true, true, true])
    open('Review your cleanup')
  }
  useEffect(() => {
    if (modal) dialog.current?.showModal()
    else dialog.current?.close()
  }, [modal])
  const changeVersion = (n: number) => {
    setVersion(n)
    const url = new URL(window.location.href)
    url.searchParams.set('v', String(n))
    window.history.replaceState(null, '', url)
    setModal(null)
  }
  const total = cleanup
    .reduce((sum, item, index) => sum + (selected[index] ? item.size : 0), 0)
    .toFixed(1)
  const header = (
    <header className="page-heading">
      <div>
        <Label>{version === 3 ? 'YOUR SYSTEM, AT A GLANCE' : 'A GOOD DAY STARTS HERE'}</Label>
        <h1>
          {version === 3
            ? 'In tune with your PC.'
            : version === 4
              ? 'Hello, brighter days.'
              : 'Good morning.'}
        </h1>
        <p>Your PC is in good shape. Let’s keep it that way.</p>
      </div>
      <button className="device-chip" onClick={() => open('This device')}>
        <Monitor size={16} />
        <span>
          My Windows PC<small>Windows 11 · This device</small>
        </span>
        <ChevronDown size={14} />
      </button>
    </header>
  )
  const metrics = (
    <div className="metrics">
      <Metric icon={Cpu} label="CPU usage" value="12" unit="%" detail="Plenty of room to work" />
      <Metric
        icon={MemoryStick}
        label="Memory"
        value="8.4"
        unit="GB"
        detail="of 32 GB · 26% in use"
        variant={1}
      />
      <Metric
        icon={HardDrive}
        label="Free storage"
        value="184"
        unit="GB"
        detail="of 512 GB on Windows (C:)"
      />
    </div>
  )
  const hero = (
    <section className="panel hero">
      <div className="hero-copy">
        <span className="status-pill">
          <span /> Your PC is doing well
        </span>
        <h2>
          A fresh start.
          <br />
          Without the effort.
        </h2>
        <p>
          Clear the clutter and make space for what’s next.
          <br />
          We found <b>4.2 GB</b> you can review.
        </p>
        <Action onClick={scan}>
          <Sparkles size={17} />
          Review cleanup
        </Action>
        <small className="hero-foot">
          <Shield size={13} />
          You choose what goes. Always.
        </small>
      </div>
      <Ring large />
    </section>
  )
  return (
    <div className={`studio theme-${version}`}>
      <div className="studio-toolbar">
        <div className="studio-brand">
          <LayoutGrid size={17} />
          <b>Design studio</b>
          <span>/</span>
          <span>Kudu Home</span>
        </div>
        <nav aria-label="Dashboard concepts">
          {concepts.map((c, i) => (
            <button
              key={c.name}
              aria-pressed={version === i + 1}
              onClick={() => changeVersion(i + 1)}
            >
              <span>0{i + 1}</span>
              {c.name}
            </button>
          ))}
        </nav>
        <span className="sample-badge">Interactive · Sample data</span>
      </div>
      <div className="app-window">
        <aside className="sidebar">
          <a
            className="brand"
            href="?v=1"
            onClick={(e) => {
              e.preventDefault()
              changeVersion(1)
            }}
          >
            <img src={logo} alt="" />
            <span>
              kudu<span className="brand-dot">.</span>
            </span>
          </a>
          <div className="workspace">
            <span className="device-avatar">
              <Monitor size={17} />
            </span>
            <div>
              <b>Personal workspace</b>
              <small>One happy computer</small>
            </div>
          </div>
          <nav aria-label="Kudu navigation">
            {nav.map(([Icon, title], i) => (
              <div key={title}>
                {i === 4 && <Label>YOUR TOOLKIT</Label>}
                <button
                  className={i === 0 ? 'active' : ''}
                  aria-label={title}
                  onClick={() => (i === 0 ? setModal(null) : open(title))}
                  aria-current={i === 0 ? 'page' : undefined}
                >
                  <Icon size={18} strokeWidth={1.65} />
                  <span>{title}</span>
                  {title === 'Applications' && <em>3</em>}
                  {title === 'Clean up' && <span className="nav-dot" />}
                </button>
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="cloud-card">
              <Cloud size={19} />
              <b>Good care. Everywhere.</b>
              <p>
                Your devices, together
                <br />
                with Kudu Cloud.
              </p>
              <button onClick={() => open('Kudu Cloud')}>
                Explore Cloud <ArrowUpRight size={14} />
              </button>
            </div>
            <button className="settings-link" onClick={() => open('Preferences')}>
              <Settings2 size={17} />
              Preferences
            </button>
            <div className="version-note">
              <span className="live-dot" />
              Kudu 2.9.0<span>Made with care</span>
            </div>
          </div>
        </aside>
        <div className="app-content">
          <div className="app-topbar">
            <span>
              Home <span className="topbar-divider">/</span> <span className="muted">Overview</span>
            </span>
            <div>
              <span className="sample-label">Preview workspace</span>
              <button
                className="icon-button"
                aria-label="Notifications"
                onClick={() => open('Notifications')}
              >
                <Bell size={17} />
                <i />
              </button>
              <span className="profile">PC</span>
            </div>
          </div>
          <main>
            {version !== 2 && header}
            {version === 1 && (
              <>
                <div className="overview-columns">
                  <div className="stack">
                    {hero}
                    {metrics}
                    <Recent open={open} />
                  </div>
                  <div className="stack right-column">
                    <section className="panel protection">
                      <IconTile icon={Shield} tone="mint" />
                      <span className="status-pill">Last scan clear</span>
                      <h3>
                        Peace of mind,
                        <br />
                        built right in.
                      </h3>
                      <p>
                        No threats found in your last scan.
                        <br />
                        Checked today at 09:38.
                      </p>
                      <button className="text-button" onClick={() => open('Protection')}>
                        View protection <ArrowRight size={15} />
                      </button>
                    </section>
                    <Tasks open={open} compact />
                    <Storage onOpen={() => open('Storage')} />
                  </div>
                </div>
              </>
            )}
            {version === 2 && (
              <div className="focus-layout">
                <div className="focus-welcome">
                  <Label>A LITTLE CARE. A BETTER DAY.</Label>
                  <h1>Ready for whatever’s next.</h1>
                  <p>Your computer feels better when everything is in its place.</p>
                </div>
                <section className="focus-hero">
                  <Ring large />
                  <div className="focus-hero-copy">
                    <span className="status-pill">
                      <span />
                      Looking good
                    </span>
                    <h2>
                      Less clutter.
                      <br />
                      More possibility.
                    </h2>
                    <p>
                      There’s 4.2 GB of extra breathing room waiting.
                      <br />
                      Take a moment to make it yours.
                    </p>
                    <Action onClick={scan}>
                      <Sparkles size={17} />
                      Let’s tidy up
                    </Action>
                    <button className="text-button" onClick={() => open('Smart scan')}>
                      Or check your whole PC <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
                <div className="focus-checks">
                  {[
                    [Shield, 'Protection', 'No threats in last scan'],
                    [Cpu, 'Performance', 'Running comfortably'],
                    [HardDrive, 'Storage', '184 GB of free space']
                  ].map(([I, title, copy]) => {
                    const Icon = I as LucideIcon
                    return (
                      <button key={String(title)} onClick={() => open(String(title))}>
                        <Icon size={22} />
                        <b>{String(title)}</b>
                        <span>{String(copy)}</span>
                        <ArrowUpRight size={15} />
                      </button>
                    )
                  })}
                </div>
                <div className="focus-bottom">
                  <div>
                    <IconTile icon={CalendarClock} tone="amber" />
                    <span>
                      <b>A routine you don’t have to think about.</b>
                      <small>Set a schedule. Let Kudu handle the little things.</small>
                    </span>
                  </div>
                  <button className="text-button" onClick={() => open('Automatic care')}>
                    Set up automatic care <ArrowRight size={16} />
                  </button>
                </div>
                <div className="focus-footer">
                  <CheckCheck size={15} />
                  2.8 GB recovered today <span>·</span> A lighter PC, one small step at a time.
                </div>
              </div>
            )}
            {version === 3 && (
              <>
                <div className="pulse-stats">
                  {metrics}
                  <section className="panel pulse-health">
                    <Ring />
                    <div>
                      <Label>SYSTEM HEALTH</Label>
                      <h3>In good shape</h3>
                      <p>2 things to fine-tune</p>
                      <button className="text-button" onClick={() => open('System health')}>
                        View details <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                </div>
                <div className="pulse-grid">
                  <section className="panel telemetry">
                    <div className="section-heading">
                      <div>
                        <h3>Room to do more</h3>
                        <p>Your system isn’t breaking a sweat.</p>
                      </div>
                      <select
                        aria-label="Performance chart time range"
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                      >
                        <option>1 hour</option>
                        <option>24 hours</option>
                      </select>
                    </div>
                    <div className="chart-key">
                      <span>
                        <i />
                        CPU <b>12%</b>
                      </span>
                      <span>
                        <i />
                        Memory <b>26%</b>
                      </span>
                      <span className="sample-label">Sample telemetry</span>
                    </div>
                    <PerformanceChart period={period} />
                    <div className="chart-summary">
                      <span>
                        <ArrowDown size={15} />
                        Low system load
                      </span>
                      <span>Intel Core i7 · 32 GB RAM</span>
                    </div>
                  </section>
                  <section className="panel pulse-clean">
                    <IconTile icon={Sparkles} tone="amber" />
                    <Label>WORTH A QUICK LOOK</Label>
                    <strong>
                      4.2 <small>GB</small>
                    </strong>
                    <h3>A little less baggage.</h3>
                    <p>
                      Temporary files and caches
                      <br />
                      are ready for your review.
                    </p>
                    <Action onClick={scan}>Review cleanup</Action>
                  </section>
                  <Recent open={open} />
                  <GameCard game={game} toggle={() => setGame(!game)} />
                </div>
                <div className="pulse-footer">
                  <Shield size={16} />
                  <span>Last protection scan clear</span>
                  <span className="live-dot" />
                  Checked today at 09:38
                  <button className="text-button" onClick={() => open('Protection')}>
                    Protection details <ArrowRight size={14} />
                  </button>
                </div>
              </>
            )}
            {version === 4 && (
              <>
                <div className="daylight-hero">
                  <div>
                    <Label>A FRESH PERSPECTIVE</Label>
                    <h2>
                      A little care.
                      <br />A lighter computer.
                    </h2>
                    <p>Your PC is doing well. A quick tidy-up will make it even better.</p>
                    <Action onClick={scan}>
                      <Sparkles size={17} />
                      Review 4.2 GB of clutter
                    </Action>
                  </div>
                  <div className="daylight-health">
                    <Ring large />
                    <span>
                      <Leaf size={16} />
                      In a good place
                    </span>
                  </div>
                  <div className="sun-lines" aria-hidden="true">
                    <Sun />
                  </div>
                </div>
                <div className="daylight-cards">
                  <button className="panel daylight-stat" onClick={() => open('Protection')}>
                    <IconTile icon={Shield} tone="mint" />
                    <ArrowUpRight size={17} />
                    <h3>All clear.</h3>
                    <p>No threats found in your last scan.</p>
                    <small>
                      <Check size={13} />
                      Checked today, 09:38
                    </small>
                  </button>
                  <button className="panel daylight-stat" onClick={() => open('Storage')}>
                    <IconTile icon={HardDrive} tone="blue" />
                    <ArrowUpRight size={17} />
                    <h3>
                      184 <span>GB free</span>
                    </h3>
                    <p>Space for your next big thing.</p>
                    <div className="mini-storage">
                      <i />
                    </div>
                  </button>
                  <button className="panel daylight-stat" onClick={() => open('Performance')}>
                    <IconTile icon={Activity} tone="amber" />
                    <ArrowUpRight size={17} />
                    <h3>Easy does it.</h3>
                    <p>12% CPU · 8.4 of 32 GB memory</p>
                    <Sparkline />
                  </button>
                </div>
                <div className="daylight-bottom">
                  <Tasks open={open} />
                  <Recent open={open} />
                </div>
              </>
            )}
            {version === 5 && (
              <>
                <div className="canvas-grid">
                  <section className="canvas-clean">
                    <div className="section-heading">
                      <span className="pill-dark">
                        <Sparkles size={14} />A LITTLE ROOM TO BREATHE
                      </span>
                      <ArrowUpRight size={24} />
                    </div>
                    <h2>
                      Out with
                      <br />
                      the clutter.
                    </h2>
                    <p>More space for the good stuff.</p>
                    <div className="canvas-size">
                      4.2
                      <span>
                        GB
                        <br />
                        to review
                      </span>
                    </div>
                    <Action onClick={scan}>Make some space</Action>
                    <div className="orbit one" />
                    <div className="orbit two" />
                  </section>
                  <section className="panel canvas-health">
                    <div className="section-heading">
                      <h3>Feeling good.</h3>
                      <HeartPulse size={20} />
                    </div>
                    <Ring />
                    <div className="health-chips">
                      <span>
                        <Check size={12} />
                        Last scan clear
                      </span>
                      <span>2 suggestions</span>
                    </div>
                  </section>
                  <section className="panel canvas-memory">
                    <div className="section-heading">
                      <h3>Room to think.</h3>
                      <MemoryStick size={19} />
                    </div>
                    <strong>
                      8.4 <small>/ 32 GB</small>
                    </strong>
                    <div className="memory-blocks">
                      {Array.from({ length: 24 }, (_, i) => (
                        <i key={i} className={i < 6 ? 'filled' : ''} />
                      ))}
                    </div>
                    <p>Your memory has plenty of headroom.</p>
                    <span className="mint-text">
                      <span className="live-dot" />
                      26% in use
                    </span>
                  </section>
                  <section className="panel canvas-impact">
                    <div>
                      <Label>THE LITTLE THINGS ADD UP</Label>
                      <h3>
                        Look at all that
                        <br />
                        breathing room.
                      </h3>
                      <strong>
                        28.6 <small>GB</small>
                      </strong>
                      <p>Recovered this month</p>
                    </div>
                    <div className="impact-bars">
                      {[24, 40, 30, 55, 46, 71, 90].map((h, i) => (
                        <i key={i} style={{ height: `${h}%` }} />
                      ))}
                      <span>01 SEP — 13 SEP</span>
                    </div>
                  </section>
                  <section className="panel canvas-shortcuts">
                    <div className="section-heading">
                      <h3>Good habits. On autopilot.</h3>
                      <CalendarClock size={19} />
                    </div>
                    <p>A little maintenance goes a long way.</p>
                    <button className="task-row" onClick={() => open('Automatic care')}>
                      <span>
                        <b>Make it a weekly thing</b>
                        <small>Set up automatic care</small>
                      </span>
                      <ArrowRight size={19} />
                    </button>
                  </section>
                  <GameCard game={game} toggle={() => setGame(!game)} />
                  <div className="canvas-recent">
                    <Recent open={open} />
                  </div>
                </div>
              </>
            )}
            <footer className="page-footer">
              <span>
                <Shield size={12} />
                Your PC. Your control.
              </span>
              <span>Open source. Thoughtfully made.</span>
            </footer>
          </main>
        </div>
      </div>
      <div className="concept-caption">
        <span>
          0{version} / {concept.name}
        </span>
        <b>{concept.note}</b>
        <p>{concept.description}</p>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="preview-dialog-title"
        onCancel={() => setModal(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setModal(null)
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setModal(null)
        }}
      >
        <div className="dialog-body">
          <div className="section-heading">
            <Label>INTERACTIVE PREVIEW · SAMPLE DATA</Label>
            <button
              className="icon-button"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
          </div>
          <IconTile
            icon={
              modal === 'Review your cleanup'
                ? Sparkles
                : modal === 'Protection'
                  ? Shield
                  : LayoutGrid
            }
            tone="amber"
          />
          <h2 id="preview-dialog-title">
            {cleaned && modal === 'Review your cleanup' ? 'A little lighter already.' : modal}
          </h2>
          {modal === 'Review your cleanup' ? (
            cleaned ? (
              <>
                <p>Preview complete. You selected {total} GB to clean.</p>
                <div className="dialog-success">
                  <CheckCheck size={22} />
                  No files were changed. This is a design preview.
                </div>
                <Action onClick={() => setModal(null)}>Back to Home</Action>
              </>
            ) : (
              <>
                <p>Choose what you’d like to clear. Your personal files stay yours.</p>
                <div className="cleanup-list">
                  {cleanup.map((item, index) => (
                    <label key={item.name}>
                      <input
                        type="checkbox"
                        checked={selected[index]}
                        onChange={() => setSelected(selected.map((v, i) => (i === index ? !v : v)))}
                      />
                      <span>{item.name}</span>
                      <b>{item.size.toFixed(1)} GB</b>
                    </label>
                  ))}
                </div>
                <div className="dialog-total">
                  <span>Selected for cleanup</span>
                  <strong>{total} GB</strong>
                </div>
                <button
                  className="action"
                  disabled={Number(total) === 0}
                  onClick={() => setCleaned(true)}
                >
                  <Sparkles size={16} />
                  Preview cleanup <ArrowRight size={16} />
                </button>
                <small className="dialog-note">
                  Simulated interaction. No system scans or file changes.
                </small>
              </>
            )
          ) : (
            <>
              <p>
                {modal === 'Application updates' || modal === 'Applications'
                  ? 'Three everyday essentials have an update available.'
                  : modal === 'Startup apps'
                    ? 'Review the apps that start with Windows.'
                    : modal === 'Notifications'
                      ? 'You’re all caught up. Here’s your latest care summary.'
                      : modal === 'Automatic care'
                        ? 'A simple weekly routine keeps the little things under control.'
                        : 'A closer look at your sample workspace.'}
              </p>
              <div className="detail-list">
                {(modal === 'Application updates' || modal === 'Applications'
                  ? [
                      'Firefox · Browser update available',
                      'VLC · Media player update available',
                      '7-Zip · Archive utility update available'
                    ]
                  : modal === 'Startup apps'
                    ? ['Discord · High startup impact', 'Steam · High startup impact']
                    : modal === 'Storage'
                      ? [
                          'Windows (C:) · 512 GB SSD',
                          '328 GB used · 184 GB available',
                          'Temporary files · 4.2 GB to review'
                        ]
                      : modal === 'Performance' || modal === 'This device'
                        ? [
                            'Intel Core i7 · 12% CPU usage',
                            '32 GB memory · 8.4 GB in use',
                            'Windows 11 · Personal workspace'
                          ]
                        : modal === 'Automatic care'
                          ? [
                              'Weekly cleanup · Sundays at 10:00',
                              'Review results before removing files',
                              'Notify me when a scan is ready'
                            ]
                          : modal === 'Protection'
                            ? [
                                'Last quick scan · Today at 09:38',
                                '18,420 files checked · No threats found',
                                'Scan results describe the last completed scan'
                              ]
                            : modal === 'Game Mode'
                              ? [
                                  `Game Mode preview · ${game ? 'On' : 'Off'}`,
                                  'Pause background activity while you play',
                                  'Restore your settings when you’re done'
                                ]
                              : [
                                  'System cleanup · 2.8 GB recovered today',
                                  'Last protection scan · No threats found',
                                  '3 application updates ready to review'
                                ]
                ).map((text) => (
                  <div key={text}>
                    <Check size={16} />
                    <span>{text}</span>
                  </div>
                ))}
              </div>
              {modal === 'Game Mode' && (
                <Action onClick={() => setGame(!game)}>
                  {game ? 'Turn off' : 'Turn on'} Game Mode preview
                </Action>
              )}
              <p className="dialog-note">
                This panel demonstrates the interaction style. All values are sample data.
              </p>
              <Action secondary onClick={() => setModal(null)}>
                Back to Home
              </Action>
            </>
          )}
        </div>
      </dialog>
    </div>
  )
}

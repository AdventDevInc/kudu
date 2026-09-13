import { useLocation } from 'react-router-dom'
import { File, Folder, ShieldCheck, Cpu, Sparkles } from 'lucide-react'
import { pageExperiences } from '@/components/layout/page-experiences'

/** Decorative, code-native artwork. It never represents file counts, scan findings, or telemetry. */
export function ToolIllustration() {
  const { pathname } = useLocation()
  const experience = pageExperiences[pathname]
  const Icon = experience?.icon ?? Sparkles
  const storage = experience?.family === 'storage'
  const protection = experience?.family === 'protection'
  const Satellite = protection ? ShieldCheck : storage ? File : Cpu
  return (
    <div
      className="pulse-tool-art"
      data-family={experience?.family}
      data-tool={experience?.key}
      aria-hidden="true"
    >
      <svg className="pulse-art-connectors" viewBox="0 0 320 170">
        <path d="M66 43 H124 Q144 43 144 63 V85 H176 M66 127 H124 Q144 127 144 107 V85 M176 85 H226 Q244 85 244 65 V43 H274 M176 85 H226 Q244 85 244 105 V127 H274" />
      </svg>
      <div className="pulse-art-node node-one">
        <Satellite size={24} strokeWidth={1.35} />
      </div>
      <div className="pulse-art-node node-two">
        {storage ? (
          <Folder size={25} strokeWidth={1.35} />
        ) : (
          <Satellite size={23} strokeWidth={1.35} />
        )}
      </div>
      <div className="pulse-art-core">
        <Icon size={36} strokeWidth={1.35} />
      </div>
      <div className="pulse-art-slat slat-one">
        <i />
        <span />
        <span />
      </div>
      <div className="pulse-art-slat slat-two">
        <i />
        <span />
        <span />
      </div>
    </div>
  )
}

import { describe, expect, it } from 'vitest'
import type { PlatformInfo } from '@shared/types'
import { pageExperiences } from '../layout/page-experiences'
import { getGoalTools, type DashboardGoal } from './simple-dashboard-tools'
import experienceTranslations from '../../locales/en/experience.json'

const goals: DashboardGoal[] = ['space', 'speed', 'protection']
const platforms: PlatformInfo['platform'][] = ['win32', 'darwin', 'linux']

describe('simple dashboard tool metadata', () => {
  for (const platform of platforms) {
    for (const goal of goals) {
      it(`provides an icon and description for every ${goal} tool on ${platform}`, () => {
        const info: PlatformInfo = {
          platform,
          features: {
            registry: platform === 'win32',
            debloater: platform === 'win32',
            drivers: platform === 'win32',
            restorePoint: platform === 'win32',
            bootTrace: platform === 'win32',
            gameMode: platform === 'win32',
            firewallAudit: platform === 'win32',
            contextMenu: platform === 'win32'
          }
        }

        for (const tool of getGoalTools(goal, info)) {
          const experience = pageExperiences[tool.path]
          expect(experience, tool.path).toBeDefined()
          expect(experience.icon, tool.path).toBeDefined()
          expect(experienceTranslations.routes, tool.path).toHaveProperty(experience.key)
        }
      })
    }
  }
})

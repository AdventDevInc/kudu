import { useTranslation } from 'react-i18next'
import { CustomFoldersPanel } from '@/components/cleaner/CustomFoldersPanel'
import { PageHeader } from '@/components/layout/PageHeader'

export function CustomFoldersPage() {
  const { t } = useTranslation('settings')

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('sectionCustomFolders')} />
      <div className="glass-card rounded-2xl p-6">
        <CustomFoldersPanel />
      </div>
    </div>
  )
}

/** Stable rule identity shared by manual and unattended cleanup. */
export function isWindowsRollback(item: { subcategory: string }): boolean {
  return item.subcategory === 'Previous Windows Installation'
}

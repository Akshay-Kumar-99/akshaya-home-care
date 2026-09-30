export type SettingsSection = 'team' | 'template';

/** Which Settings page the address asks for (?section=…, or the earlier ?tab=…); null = the tile grid. */
export function settingsSectionFrom(params: URLSearchParams): SettingsSection | null {
  const value = params.get('section') ?? params.get('tab');
  if (value === 'team') return 'team';
  if (value === 'template' || value === 'invoice') return 'template';
  return null;
}

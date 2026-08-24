import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList, SettingsSwitchRow } from '../primitives';

interface LibrarySettingsProps {
  skeuomorphicCovers: boolean;
  showKavitaSourceBadge: boolean;
  showKavitaStatusBadge: boolean;
  onSkeuomorphicCoversToggle: (enabled: boolean) => void;
  onKavitaSourceBadgeToggle: (enabled: boolean) => void;
  onKavitaStatusBadgeToggle: (enabled: boolean) => void;
  'data-setting-id'?: string;
}

const LibrarySettings: React.FC<LibrarySettingsProps> = ({
  skeuomorphicCovers,
  showKavitaSourceBadge,
  showKavitaStatusBadge,
  onSkeuomorphicCoversToggle,
  onKavitaSourceBadgeToggle,
  onKavitaStatusBadgeToggle,
  'data-setting-id': dataSettingId,
}) => {
  const _ = useTranslation();

  return (
    <BoxedList title={_('Library')} data-setting-id={dataSettingId}>
      <SettingsSwitchRow
        label={_('Skeuomorphic Book Covers')}
        checked={skeuomorphicCovers}
        onChange={() => onSkeuomorphicCoversToggle(!skeuomorphicCovers)}
      />
      <SettingsSwitchRow
        label={_('Show Kavita Source Badges')}
        checked={showKavitaSourceBadge}
        onChange={() => onKavitaSourceBadgeToggle(!showKavitaSourceBadge)}
      />
      <SettingsSwitchRow
        label={_('Show Kavita Status Badges')}
        checked={showKavitaStatusBadge}
        onChange={() => onKavitaStatusBadgeToggle(!showKavitaStatusBadge)}
      />
    </BoxedList>
  );
};

export default LibrarySettings;

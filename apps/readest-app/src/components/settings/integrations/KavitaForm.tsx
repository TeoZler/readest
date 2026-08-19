import React, { useEffect, useMemo, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { isTauriAppPlatform } from '@/services/environment';
import { syncAllKavitaCatalogs } from '@/services/kavita/catalogManager';
import { getKavitaConnectionRepository } from '@/services/kavita/connections';
import {
  diagnoseKavitaConnection,
  type KavitaConnectionDiagnosticResult,
} from '@/services/kavita/diagnostics';
import { redactKavitaSecret } from '@/services/kavita/redaction';
import type { KavitaConnectionConfig } from '@/services/kavita/types';
import { clearKavitaRangeCache, getKavitaRangeCacheBytes } from '@/services/kavita/rangeCache';
import { clearKavitaCoverUrls, deleteStoredKavitaCovers } from '@/services/kavita/cover';
import {
  clearKavitaCoverCache,
  getKavitaCoverCacheBytes,
  getKavitaCoverCacheSettings,
  saveKavitaCoverCacheSettings,
} from '@/services/kavita/coverCache';
import { eventDispatcher } from '@/utils/event';
import { getLocalBookFilename } from '@/utils/book';
import SubPageHeader from '../SubPageHeader';
import { SectionTitle, SettingLabel, Tips } from '../primitives';

interface KavitaFormProps {
  onBack: () => void;
  onConnectionsChanged?: () => void;
}

const inputClass =
  'input input-bordered bg-base-100 h-10 w-full rounded-lg px-3 text-sm focus:outline-none';

const KavitaForm: React.FC<KavitaFormProps> = ({ onBack, onConnectionsChanged }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const repository = useMemo(() => getKavitaConnectionRepository(), []);
  const [connections, setConnections] = useState<KavitaConnectionConfig[]>(
    () => repository?.list() ?? [],
  );
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [allowInvalidTls, setAllowInvalidTls] = useState(false);
  const [diagnostic, setDiagnostic] = useState<KavitaConnectionDiagnosticResult | null>(null);
  const [selectedLibraries, setSelectedLibraries] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cacheBytes, setCacheBytes] = useState<Record<string, number>>({});
  const [coverCacheSettings, setCoverCacheSettings] = useState(getKavitaCoverCacheSettings);
  const [coverCacheBytes, setCoverCacheBytes] = useState(0);

  useEffect(() => {
    void Promise.all(
      connections.map(
        async (connection) =>
          [connection.id, await getKavitaRangeCacheBytes(connection.id)] as const,
      ),
    ).then((entries) => setCacheBytes(Object.fromEntries(entries)));
  }, [connections]);

  useEffect(() => {
    void envConfig
      .getAppService()
      .then(getKavitaCoverCacheBytes)
      .then(setCoverCacheBytes)
      .catch(() => setCoverCacheBytes(0));
  }, [envConfig]);

  const refreshConnections = () => {
    setConnections(repository?.list() ?? []);
    onConnectionsChanged?.();
  };

  const runDiagnostic = async () => {
    setBusy(true);
    setError('');
    setDiagnostic(null);
    try {
      const result = await diagnoseKavitaConnection({
        baseUrl,
        authKey,
        allowInvalidTls,
      });
      setDiagnostic(result);
      setSelectedLibraries(new Set());
    } catch (cause) {
      setError(redactKavitaSecret(cause, authKey));
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = async () => {
    if (!repository || !diagnostic || selectedLibraries.size === 0) return;
    setBusy(true);
    setError('');
    try {
      const now = Date.now();
      const id = crypto.randomUUID();
      const config: KavitaConnectionConfig = {
        id,
        serverId: diagnostic.server.serverId,
        name: name.trim() || diagnostic.server.username || 'Kavita',
        defaultBaseUrl: new URL(baseUrl).toString().replace(/\/$/, ''),
        selectedLibraryIds: Array.from(selectedLibraries).sort((a, b) => a - b),
        progressStrategy: 'ask',
        createdAt: now,
        updatedAt: now,
      };
      const device = {
        ...repository.getDeviceConfig(id),
        allowInvalidTls,
        lastDiagnostic: { checkedAt: now, ok: true },
      };
      await repository.save(config, device, authKey.trim());
      if (repository.credentialWarning) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 8000,
          message: repository.credentialWarning,
        });
      }
      refreshConnections();
      setName('');
      setBaseUrl('');
      setAuthKey('');
      setDiagnostic(null);
      setSelectedLibraries(new Set());
      await syncAllKavitaCatalogs(envConfig);
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Kavita connected') });
    } catch (cause) {
      setError(redactKavitaSecret(cause, authKey));
    } finally {
      setBusy(false);
    }
  };

  const syncConnection = async () => {
    setBusy(true);
    setError('');
    try {
      await syncAllKavitaCatalogs(envConfig);
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Kavita library synced') });
    } catch (cause) {
      setError(redactKavitaSecret(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateDevice = (
    connection: KavitaConnectionConfig,
    patch: { baseUrlOverride?: string; allowInvalidTls?: boolean },
  ) => {
    if (!repository) return;
    const current = repository.getDeviceConfig(connection.id);
    repository.saveDeviceConfig({ ...current, ...patch });
  };

  const removeConnection = async (connection: KavitaConnectionConfig) => {
    if (!repository) return;
    const affected = useLibraryStore
      .getState()
      .library.filter((book) => book.kavitaSource?.connectionId === connection.id);
    const offline = affected.filter((book) => book.kavitaSource?.offlineState === 'offline');
    const bytes = offline.reduce((sum, book) => sum + (book.kavitaSource?.fileBytes ?? 0), 0);
    const typed = window.prompt(
      _(
        'Removing this server affects {{books}} book(s), including {{offline}} offline copy/copies ({{size}} MiB). Type “{{name}}” to continue.',
        {
          books: affected.length,
          offline: offline.length,
          size: (bytes / 1024 / 1024).toFixed(1),
          name: connection.name,
        },
      ),
    );
    if (typed !== connection.name) return;
    const appService = await envConfig.getAppService();
    await Promise.all(
      offline.map((book) =>
        appService.deleteFile(getLocalBookFilename(book), 'Books').catch(() => undefined),
      ),
    );
    await deleteStoredKavitaCovers(appService, affected);
    await clearKavitaRangeCache(connection.id);
    clearKavitaCoverUrls(connection.id);
    await repository.remove(connection.id, typed);
    const next = useLibraryStore
      .getState()
      .library.filter((book) => book.kavitaSource?.connectionId !== connection.id);
    await appService.saveLibraryBooks(next);
    useLibraryStore.getState().setLibrary(next);
    refreshConnections();
  };

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('Kavita')}
        description={_('Read EPUB books from one or more Kavita servers.')}
        onBack={onBack}
      />

      {connections.length > 0 && (
        <div className='mb-6 space-y-2'>
          <SectionTitle>{_('Connected Servers')}</SectionTitle>
          <div className='card eink-bordered border-base-200 bg-base-100 flex flex-wrap items-end gap-3 border p-4'>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                className='checkbox checkbox-sm'
                checked={coverCacheSettings.enabled}
                onChange={(event) => {
                  const next = { ...coverCacheSettings, enabled: event.target.checked };
                  setCoverCacheSettings(next);
                  saveKavitaCoverCacheSettings(next);
                }}
              />
              {_('Persistent cover cache')}
            </label>
            <label className='text-sm'>
              <span className='text-base-content/70 me-2'>{_('Global limit (MiB)')}</span>
              <input
                type='number'
                min={0}
                className='input input-bordered h-9 w-28'
                value={Math.round(coverCacheSettings.capacityBytes / 1024 / 1024)}
                onChange={(event) => {
                  const next = {
                    ...coverCacheSettings,
                    capacityBytes: Math.max(0, Number(event.target.value) || 0) * 1024 * 1024,
                  };
                  setCoverCacheSettings(next);
                  saveKavitaCoverCacheSettings(next);
                }}
              />
            </label>
            <button
              type='button'
              className='btn btn-sm'
              onClick={async () => {
                clearKavitaCoverUrls();
                await clearKavitaCoverCache(await envConfig.getAppService());
                setCoverCacheBytes(0);
              }}
            >
              {_('Clear cover cache')} ({(coverCacheBytes / 1024 / 1024).toFixed(1)} MiB)
            </button>
          </div>
          {connections.map((connection) => {
            const device = repository?.getDeviceConfig(connection.id);
            return (
              <div
                key={connection.id}
                className='card eink-bordered border-base-200 bg-base-100 space-y-3 border p-4'
              >
                <div className='flex items-start justify-between gap-3'>
                  <div className='min-w-0'>
                    <div className='font-medium'>{connection.name}</div>
                    <div className='text-base-content/60 truncate text-xs'>
                      {connection.defaultBaseUrl}
                    </div>
                    <div className='text-base-content/60 text-xs'>
                      {_('{{count}} selected library/libraries', {
                        count: connection.selectedLibraryIds.length,
                      })}
                    </div>
                  </div>
                  <div className='flex gap-2'>
                    <button
                      className='btn btn-sm'
                      type='button'
                      disabled={busy}
                      onClick={syncConnection}
                    >
                      {_('Sync now')}
                    </button>
                    <button
                      className='btn btn-error btn-sm'
                      type='button'
                      disabled={busy}
                      onClick={() => removeConnection(connection)}
                    >
                      {_('Remove')}
                    </button>
                  </div>
                </div>
                <label className='block'>
                  <SettingLabel>{_('Device URL override')}</SettingLabel>
                  <input
                    className={inputClass}
                    defaultValue={device?.baseUrlOverride ?? ''}
                    placeholder={connection.defaultBaseUrl}
                    onBlur={(event) =>
                      updateDevice(connection, {
                        baseUrlOverride: event.target.value.trim() || undefined,
                      })
                    }
                  />
                </label>
                {isTauriAppPlatform() && (
                  <label className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      className='checkbox checkbox-sm'
                      defaultChecked={device?.allowInvalidTls ?? false}
                      onChange={(event) =>
                        updateDevice(connection, { allowInvalidTls: event.target.checked })
                      }
                    />
                    {_('Allow an invalid TLS certificate on this device')}
                  </label>
                )}
                <label className='block text-sm'>
                  <SettingLabel>{_('Progress conflict policy')}</SettingLabel>
                  <select
                    className='select select-bordered h-10 w-full'
                    value={connection.progressStrategy}
                    onChange={async (event) => {
                      if (!repository) return;
                      await repository.save(
                        {
                          ...connection,
                          progressStrategy: event.target
                            .value as KavitaConnectionConfig['progressStrategy'],
                          updatedAt: Date.now(),
                        },
                        repository.getDeviceConfig(connection.id),
                      );
                      refreshConnections();
                    }}
                  >
                    <option value='ask'>{_('Ask when remote progress differs')}</option>
                    <option value='prefer-local'>{_('Prefer this device')}</option>
                    <option value='prefer-remote'>{_('Prefer Kavita')}</option>
                  </select>
                </label>
                <div className='flex flex-wrap items-end gap-3'>
                  <label className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      className='checkbox checkbox-sm'
                      defaultChecked={device?.cacheEnabled ?? true}
                      onChange={(event) =>
                        repository?.saveDeviceConfig({
                          ...repository.getDeviceConfig(connection.id),
                          cacheEnabled: event.target.checked,
                        })
                      }
                    />
                    {_('Persistent Range cache')}
                  </label>
                  <label className='text-sm'>
                    <span className='text-base-content/70 me-2'>{_('Limit (MiB)')}</span>
                    <input
                      type='number'
                      min={0}
                      className='input input-bordered h-9 w-24'
                      defaultValue={Math.round((device?.cacheCapacityBytes ?? 0) / 1024 / 1024)}
                      onBlur={(event) =>
                        repository?.saveDeviceConfig({
                          ...repository.getDeviceConfig(connection.id),
                          cacheCapacityBytes:
                            Math.max(0, Number(event.target.value) || 0) * 1024 * 1024,
                        })
                      }
                    />
                  </label>
                  <button
                    type='button'
                    className='btn btn-sm'
                    onClick={async () => {
                      await clearKavitaRangeCache(connection.id);
                      setCacheBytes((current) => ({ ...current, [connection.id]: 0 }));
                    }}
                  >
                    {_('Clear cache')} (
                    {((cacheBytes[connection.id] ?? 0) / 1024 / 1024).toFixed(1)} MiB)
                  </button>
                </div>
                {device?.lastDiagnostic && !device.lastDiagnostic.ok && (
                  <p className='text-error text-sm'>{device.lastDiagnostic.message}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionTitle>{_('Add Server')}</SectionTitle>
      <div className='card eink-bordered border-base-200 bg-base-100 space-y-4 border p-4'>
        <label className='block'>
          <SettingLabel>{_('Server name')}</SettingLabel>
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={_('Home Kavita')}
          />
        </label>
        <label className='block'>
          <SettingLabel>{_('Kavita URL')}</SettingLabel>
          <input
            className={inputClass}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder='http://192.168.1.10:5000'
          />
        </label>
        <label className='block'>
          <SettingLabel>{_('Auth Key')}</SettingLabel>
          <input
            className={inputClass}
            type='password'
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            autoComplete='off'
          />
        </label>
        {isTauriAppPlatform() && (
          <label className='flex items-center gap-2 text-sm'>
            <input
              type='checkbox'
              className='checkbox checkbox-sm'
              checked={allowInvalidTls}
              onChange={(event) => setAllowInvalidTls(event.target.checked)}
            />
            {_('Allow an invalid TLS certificate on this device')}
          </label>
        )}
        <button
          className='btn btn-primary btn-sm self-start'
          type='button'
          disabled={busy || !baseUrl.trim() || !authKey.trim()}
          onClick={runDiagnostic}
        >
          {busy ? _('Checking…') : _('Check connection')}
        </button>

        {diagnostic && (
          <div className='space-y-2'>
            <p className='text-success text-sm'>
              {_('Connected as {{username}} to Kavita {{version}}', {
                username: diagnostic.server.username,
                version: diagnostic.server.kavitaVersion,
              })}
            </p>
            <SettingLabel>{_('Select libraries to import')}</SettingLabel>
            {diagnostic.libraries.map((library) => (
              <label key={library.id} className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  className='checkbox checkbox-sm'
                  checked={selectedLibraries.has(library.id)}
                  onChange={(event) => {
                    const next = new Set(selectedLibraries);
                    if (event.target.checked) next.add(library.id);
                    else next.delete(library.id);
                    setSelectedLibraries(next);
                  }}
                />
                {library.name || `Library ${library.id}`}
              </label>
            ))}
            <button
              className='btn btn-primary btn-sm mt-2'
              type='button'
              disabled={busy || selectedLibraries.size === 0}
              onClick={saveConnection}
            >
              {_('Connect and import')}
            </button>
          </div>
        )}
        {error && <p className='text-error break-words text-sm'>{error}</p>}
      </div>

      <div className='mt-5'>
        <Tips>
          <li>{_('The Kavita account must have Download permission.')}</li>
          <li>{_('Public servers require HTTPS. Private-network HTTP is allowed.')}</li>
          <li>{_('Web support depends on the Kavita server CORS and Range configuration.')}</li>
        </Tips>
      </div>
    </div>
  );
};

export default KavitaForm;

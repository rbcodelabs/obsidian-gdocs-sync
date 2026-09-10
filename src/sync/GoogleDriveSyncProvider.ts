import type { AppendOnlySession, AppendOnlySyncProvider, VaultDescriptor } from 'geode';
import { TokenStore } from '../auth/TokenStore';
import { canonicalJson, ImmutableDriveClient, sha256Bytes, type DriveAuth, type DriveJournal } from './drive/ImmutableDriveClient';
import { DriveHistorySession, listFiles, metadataOf, objectProperties, PROTOCOL, validateDescriptorShape } from './drive/DriveHistorySession';

export interface DriveProviderConfig {
  loadDeviceState<T>(key: string): Promise<T | null>;
  saveDeviceState(key: string, value: unknown): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
  saveSecret(key: string, value: string): Promise<void>;
  removeSecret(key: string): Promise<void>;
  excludePath?(path: string, data?: ArrayBuffer): string | null | Promise<string | null>;
  onDiscoveryIssue?(issue: { rootId: string; message: string }): void;
}

/** Managed immutable history, not a mutable Drive folder mirror. Beta remains gated in main.ts. */
export class GoogleDriveSyncProvider implements AppendOnlySyncProvider {
  readonly id = 'google-drive.full-vault';
  readonly name = 'Google Drive (managed vault)';
  readonly protocol = PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  private clients = new Map<string, ImmutableDriveClient>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private tokens: TokenStore, private config: DriveProviderConfig) {}

  excludePath(path: string, data?: ArrayBuffer) { return this.config.excludePath?.(path, data) ?? null; }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> {
    const context = await this.context(signal);
    const roots = await listFiles(context.client, `trashed=false and appProperties has { key='geodeSyncProtocol' and value='${PROTOCOL}' } and appProperties has { key='geodeObjectKind' and value='root' }`, signal);
    const result: VaultDescriptor[] = [];
    const identities = new Set<string>();
    for (const root of roots) {
      const identity = root.appProperties?.geodeVaultId;
      if (identity && identities.has(identity)) throw new Error('Multiple Drive roots use the same vault identity; explicit repair is required');
      if (identity) identities.add(identity);
    }
    for (const root of roots) {
      try {
      const descriptorId = root.appProperties?.geodeDescriptorId;
      if (!descriptorId) throw new Error('Managed Drive root is missing its descriptor');
      const response = await context.client.request({ url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(descriptorId)}?alt=media` }, signal);
      const descriptor = JSON.parse(new TextDecoder().decode(response.arrayBuffer)) as VaultDescriptor;
      await this.validateBinding(context.client, descriptor, signal);
      if (descriptor.rootId !== root.id) throw new Error('Drive descriptor root identity mismatch');
      if (result.some(item => item.vaultId === descriptor.vaultId)) throw new Error('Multiple Drive roots use the same vault identity; explicit repair is required');
      result.push(descriptor);
      } catch {
        context.auth.assertCurrent(); signal.throwIfAborted();
        this.config.onDiscoveryIssue?.({ rootId: root.id, message: 'This managed root is incomplete or invalid. Retry setup or inspect its descriptor; it was not adopted or repaired.' });
      }
    }
    if (roots.length && !result.length) throw new Error('No valid managed vault descriptors were found; incomplete or invalid roots require attention');
    return result;
  }

  createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> {
    return this.serial(async () => {
      if (!/^[\da-f-]{36}$/i.test(input.operationId) || !input.name.trim()) throw new Error('Invalid vault setup operation');
      const context = await this.context(signal);
      const setupKey = `drive/setup/${context.accountId}/${input.operationId}`;
      let binding = await this.config.loadDeviceState<VaultDescriptor>(setupKey);
      context.auth.assertCurrent(); signal.throwIfAborted();
      if (binding) {
        validateDescriptorShape(binding);
        if (binding.name !== input.name) throw new Error('Setup operation reused with a different vault name');
      } else {
        const result = await context.client.request({ url: 'https://www.googleapis.com/drive/v3/files/generateIds?count=2&space=drive&type=files' }, signal);
        const ids = result.json?.ids;
        if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== 'string' || !/^[\w-]+$/.test(id)) || ids[0] === ids[1]) throw new Error('Drive returned invalid setup IDs');
        binding = { schema: 1, protocol: PROTOCOL, vaultId: crypto.randomUUID(), rootId: ids[0], descriptorId: ids[1], name: input.name };
        context.auth.assertCurrent(); signal.throwIfAborted();
        // Account+operation lookup survives a crash without inventing a new vault UUID.
        await this.config.saveDeviceState(setupKey, binding);
      }
      const client = this.client(context.auth, context.accountId, `${binding.vaultId}/${binding.rootId}/${binding.descriptorId}`, context.generation);
      const empty = new ArrayBuffer(0);
      await client.create({ operationKey: `root:${input.operationId}`, driveId: binding.rootId, metadata: { name: binding.name, mimeType: 'application/vnd.google-apps.folder', appProperties: { ...objectProperties(binding, 'root'), geodeDescriptorId: binding.descriptorId } }, data: empty, sha256: await sha256Bytes(empty) }, signal);
      const data = new TextEncoder().encode(canonicalJson(binding)).buffer;
      await client.create({ operationKey: `descriptor:${input.operationId}`, driveId: binding.descriptorId, metadata: { name: 'vault.json', mimeType: 'application/json', parents: [binding.rootId], appProperties: objectProperties(binding, 'descriptor') }, data, sha256: await sha256Bytes(data) }, signal);
      await this.validateBinding(client, binding, signal);
      return binding;
    });
  }

  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<AppendOnlySession> {
    if (!/^[\da-f-]{36}$/i.test(context.deviceId)) throw new Error('Invalid device identity');
    const account = await this.context(signal);
    validateDescriptorShape(context.binding);
    const client = this.client(account.auth, account.accountId, `${context.binding.vaultId}/${context.binding.rootId}/${context.binding.descriptorId}`, account.generation);
    await this.validateBinding(client, context.binding, signal);
    return new DriveHistorySession(client, structuredClone(context.binding), context.deviceId, account.accountId, this.config, account.auth, work => this.serial(work));
  }

  private async validateBinding(client: ImmutableDriveClient, binding: VaultDescriptor, signal: AbortSignal): Promise<void> {
    validateDescriptorShape(binding);
    const root = await metadataOf(client, binding.rootId, signal);
    const rootProperties = { ...objectProperties(binding, 'root'), geodeDescriptorId: binding.descriptorId };
    if (root.trashed || root.mimeType !== 'application/vnd.google-apps.folder' || canonicalJson(root.appProperties) !== canonicalJson(rootProperties)) throw new Error('Drive root schema or identity integrity failure');
    const descriptor = await metadataOf(client, binding.descriptorId, signal);
    if (descriptor.trashed || canonicalJson(descriptor.parents) !== canonicalJson([binding.rootId]) || canonicalJson(descriptor.appProperties) !== canonicalJson(objectProperties(binding, 'descriptor'))) throw new Error('Drive descriptor identity integrity failure');
    const response = await client.request({ url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(binding.descriptorId)}?alt=media` }, signal);
    const actual = JSON.parse(new TextDecoder().decode(response.arrayBuffer));
    if (canonicalJson(actual) !== canonicalJson(binding)) throw new Error('Drive descriptor content integrity failure');
  }

  private async context(signal: AbortSignal) {
    if (!this.tokens.hasSecureStorage()) throw new Error('Managed vault sync requires Geode secure credentials');
    const generation = this.tokens.getGeneration();
    const auth: DriveAuth = {
      assertCurrent: () => this.tokens.assertGeneration(generation),
      getAccessToken: async () => { this.tokens.assertGeneration(generation); const token = await this.tokens.getValidAccessToken(); this.tokens.assertGeneration(generation); return token; },
      refreshAccessToken: async () => { this.tokens.assertGeneration(generation); const token = await this.tokens.getValidAccessToken(true); this.tokens.assertGeneration(generation); return token; },
    };
    const probe = new ImmutableDriveClient(auth, { load: async () => null, save: async () => { throw new Error('Account probe cannot reserve objects'); } });
    const result = await probe.request({ url: 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)' }, signal);
    const accountId = result.json?.user?.permissionId;
    if (typeof accountId !== 'string' || !/^[\w-]+$/.test(accountId)) throw new Error('Google account identity is unavailable');
    return { auth, accountId, generation, client: this.client(auth, accountId, 'discovery', generation) };
  }

  private client(auth: DriveAuth, account: string, vault: string, generation: number): ImmutableDriveClient {
    const key = `drive/objects/${account}/${vault}`;
    const cacheKey = `${generation}:${key}`;
    const previous = this.clients.get(cacheKey); if (previous) return previous;
    const journal: DriveJournal = {
      load: async operationKey => { auth.assertCurrent(); const value = await this.config.loadDeviceState<import('./drive/ImmutableDriveClient').ReservedObject>(`${key}/${encodeURIComponent(operationKey)}`); auth.assertCurrent(); return value ?? null; },
      save: async (operationKey, value) => { auth.assertCurrent(); await this.config.saveDeviceState(`${key}/${encodeURIComponent(operationKey)}`, value); auth.assertCurrent(); },
    };
    const client = new ImmutableDriveClient(auth, journal, { sessions: { load: key => this.config.loadSecret(key), save: (key, value) => this.config.saveSecret(key, value), remove: key => this.config.removeSecret(key) } });
    this.clients.set(cacheKey, client); return client;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work, work); this.operations = next.catch(() => undefined); return next;
  }
}

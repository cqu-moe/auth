import { z } from '@hono/zod-openapi';

export const ReleaseVersion = z.string().regex(/^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/)
  .refine(value => value !== '0.0.0' && value.split('.').every(part => Number(part) <= 65535));
const ReleaseFields = z.strictObject({
  schemaVersion: z.literal(1), channel: z.literal('canary'), version: ReleaseVersion,
  filename: z.string(), objectKey: z.string(), size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  protocolVersion: z.number().int().positive(), contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.iso.datetime({ offset: true }), notes: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
});
export const ReleaseRecordSchema = ReleaseFields.refine(record => record.filename === `cqu-quicklogin-${record.version}-canary.zip`
  && record.objectKey === `quicklogin/releases/${record.version}/${record.filename}`);
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;
export const PublicReleaseSchema = ReleaseFields.pick({ version: true, filename: true, size: true,
  sha256: true, publishedAt: true, notes: true }).strip();

export class ReleaseError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 503, public readonly code: string, message: string) { super(message); }
}

export function requestedVersion(url: string): string | undefined {
  const values = new URL(url).searchParams.getAll('version');
  if (values.length > 1 || (values.length === 1 && !ReleaseVersion.safeParse(values[0]).success)) {
    throw new ReleaseError(400, 'INVALID_VERSION', '版本号无效，请返回下载页重试。');
  }
  return values[0];
}

export async function readRelease(bucket: R2Bucket | undefined, version?: string): Promise<ReleaseRecord> {
  if (!bucket) throw new ReleaseError(503, 'RELEASE_UNAVAILABLE', '下载服务暂不可用，请稍后重试。');
  if (version !== undefined && !ReleaseVersion.safeParse(version).success) throw new ReleaseError(400, 'INVALID_VERSION', '版本号无效。');
  const key = version ? `quicklogin/releases/${version}/release.json` : 'quicklogin/channels/canary.json';
  const object = await bucket.get(key);
  if (!object) throw new ReleaseError(version ? 404 : 503, 'RELEASE_UNAVAILABLE', '安装包暂不可用，请稍后重试。');
  if (object.size > 65536) throw new ReleaseError(503, 'INVALID_RELEASE', '版本信息暂不可用。');
  const result = ReleaseRecordSchema.safeParse(await object.json());
  if (!result.success || (version !== undefined && result.data.version !== version)) {
    throw new ReleaseError(503, 'INVALID_RELEASE', '版本信息暂不可用。');
  }
  return result.data;
}

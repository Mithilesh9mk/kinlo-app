import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { parseInviteToken } from './friendInvites';
import { buildQrPng, base64ToBytes, scanJpegBytes } from './qrCodec';

/** Writes a PNG of the invite QR to the cache dir and opens the share sheet. Throws on failure. */
export async function shareInviteQrImage(link: string, caption?: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  const png = buildQrPng(link, 600);
  const file = new File(Paths.cache, 'kinlo-invite-qr.png');
  file.create({ overwrite: true });
  file.write(png);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'image/png',
    dialogTitle: caption || 'Share your Kinlo QR',
    UTI: 'public.png',
  });
}

const FIRST_MAX_SIDE = 1000;

async function scanAtScale(
  uri: string,
  srcW: number | undefined,
  srcH: number | undefined,
  maxSide: number,
): Promise<string | null> {
  let context = ImageManipulator.manipulate(uri);
  if (srcW && srcH && Math.max(srcW, srcH) > maxSide) {
    const k = maxSide / Math.max(srcW, srcH);
    context = context.resize({ width: Math.round(srcW * k), height: Math.round(srcH * k) });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.9, format: SaveFormat.JPEG, base64: true });
  if (!saved.base64) return null;
  return scanJpegBytes(base64ToBytes(saved.base64));
}

/** Lets the user pick a screenshot/photo of an invite QR and returns the token inside it. Never throws. */
export async function scanInviteFromPhoto(): Promise<
  { status: 'found'; token: string } | { status: 'cancelled' } | { status: 'not_found' } | { status: 'error' }
> {
  try {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (picked.canceled || !picked.assets?.[0]?.uri) return { status: 'cancelled' };
    const asset = picked.assets[0];
    const long = Math.max(asset.width || 0, asset.height || 0);

    // Second attempt at a different scale: a small QR in a big screenshot
    // needs more resolution; a camera photo is better off smaller.
    const scales = [FIRST_MAX_SIDE, long > 1400 ? 1600 : 640];

    let hadDecodeError = false;
    let hadSuccessfulPass = false;
    for (const maxSide of scales) {
      try {
        const text = await scanAtScale(asset.uri, asset.width, asset.height, maxSide);
        hadSuccessfulPass = true;
        const token = text ? parseInviteToken(text) : null;
        if (token) return { status: 'found', token };
      } catch {
        hadDecodeError = true;
      }
    }
    return hadSuccessfulPass || !hadDecodeError ? { status: 'not_found' } : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

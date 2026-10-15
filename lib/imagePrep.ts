import { Image } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/**
 * Downscales and recompresses a picked/shared payment screenshot before it
 * ever leaves the device. A vision model reads these for text, not for
 * detail, so capping the longer edge and recompressing to JPEG cuts the
 * bytes at every downstream step (upload, the payload sent to Gemini, and
 * Gemini's own inference time) with no meaningful loss of legibility.
 *
 * Throws on failure (e.g. a URI scheme the manipulator can't load) — callers
 * fall back to uploading/scanning the original, uncompressed image rather
 * than losing the scan.
 */

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.7;

export interface PreparedImage {
  base64: string;
  mimeType: string;
  /** The compressed file on disk. Upload reads its bytes natively rather than
   * decoding `base64` back in JS — that decode is a synchronous per-character
   * loop over megabytes, which blocks the JS thread mid-navigation. */
  uri: string;
}

export async function prepareReceiptImage(uri: string): Promise<PreparedImage> {
  let resize: { width: number; height: number } | undefined;
  try {
    const { width, height } = await getImageSize(uri);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / Math.max(width, height);
      resize = { width: Math.round(width * scale), height: Math.round(height * scale) };
    }
  } catch {
    // Dimension probe failed (some content:// URIs don't support it) — still
    // worth recompressing at original size rather than skipping entirely.
  }

  let context = ImageManipulator.manipulate(uri);
  if (resize) context = context.resize(resize);
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG, base64: true });

  if (!result.base64) throw new Error('Image manipulator did not return base64 data');
  return { base64: result.base64, mimeType: 'image/jpeg', uri: result.uri };
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

declare module 'qrcode/lib/core/qrcode' {
  const QRCode: {
    create(
      text: string,
      options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' | string; version?: number; maskPattern?: number },
    ): { modules: { size: number; data: ArrayLike<number> }; version: number };
  };
  export default QRCode;
}

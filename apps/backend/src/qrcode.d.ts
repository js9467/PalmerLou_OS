declare module "qrcode" {
  interface QRCodeOptions {
    type?: string;
    margin?: number;
    [key: string]: unknown;
  }
  function toString(text: string, options?: QRCodeOptions): Promise<string>;
  export default { toString };
}

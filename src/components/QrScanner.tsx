import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useLanguage } from '../battle/i18n'
import { canScanQr, roomCodeFromScan } from '../battle/inviteCode'

type Decode = (source: HTMLVideoElement | HTMLCanvasElement) => Promise<string | null>

interface NativeBarcodeDetector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
type NativeBarcodeDetectorClass = { new (options: { formats: string[] }): NativeBarcodeDetector; getSupportedFormats?: () => Promise<string[]> }

/** Prefer the browser's own detector (Chrome on Android); otherwise jsQR, loaded only when scanning. */
async function createDecoder(): Promise<Decode> {
  const Native = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorClass }).BarcodeDetector
  if (Native) {
    try {
      const formats = await Native.getSupportedFormats?.()
      if (!formats || formats.includes('qr_code')) {
        const detector = new Native({ formats: ['qr_code'] })
        return async source => (await detector.detect(source))[0]?.rawValue ?? null
      }
    } catch { /* Fall through to jsQR. */ }
  }
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  return async source => {
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height
    if (!width || !height) return null
    // Downscale large frames: decoding a 640px frame is plenty for a QR code and much faster.
    const scale = Math.min(1, 640 / Math.max(width, height))
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null
  }
}

/** Camera view that resolves to a room code from an invite QR (or a bare room code QR). */
export function QrScanner({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useLanguage()
  const video = useRef<HTMLVideoElement>(null)
  const decoder = useRef<Promise<Decode> | null>(null)
  const done = useRef(false)
  const onCodeRef = useRef(onCode); onCodeRef.current = onCode
  const [status, setStatus] = useState<'starting' | 'scanning' | 'denied' | 'unavailable'>('starting')
  const [hint, setHint] = useState('')

  const getDecoder = () => (decoder.current ??= createDecoder())
  const accept = (text: string | null) => {
    if (!text || done.current) return false
    const code = roomCodeFromScan(text)
    if (!code) { setHint(t('这不是房间邀请二维码。', 'That QR code is not a room invite.')); return false }
    done.current = true
    onCodeRef.current(code)
    return true
  }

  useEffect(() => {
    let stream: MediaStream | null = null
    let frame = 0
    let stopped = false
    let last = 0
    const tick = async (time: number) => {
      if (stopped || done.current) return
      const element = video.current
      if (element && element.readyState >= 2 && time - last > 180) {
        last = time
        try { if (accept(await (await getDecoder())(element))) return } catch { /* Try the next frame. */ }
      }
      if (!stopped) frame = requestAnimationFrame(time => void tick(time))
    }
    const start = async () => {
      if (!canScanQr()) { setStatus('unavailable'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return }
        const element = video.current!
        element.srcObject = stream
        await element.play().catch(() => undefined)
        setStatus('scanning')
        void getDecoder()
        frame = requestAnimationFrame(time => void tick(time))
      } catch (error) {
        if (stopped) return
        setStatus(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'unavailable')
      }
    }
    void start()
    return () => { stopped = true; cancelAnimationFrame(frame); stream?.getTracks().forEach(track => track.stop()) }
  }, [])

  // Fallback when the camera is blocked: decode a screenshot or photo of the invite QR.
  const pickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setHint('')
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      if (!accept(await (await getDecoder())(canvas)) && !done.current) setHint(t('图片里没有识别到房间二维码。', 'No room QR code found in that image.'))
    } catch { setHint(t('无法读取这张图片。', 'Could not read that image.')) }
  }

  return <div className="battle-qr-scanner">
    <div className="battle-qr-viewfinder">
      <video ref={video} playsInline muted autoPlay aria-label={t('相机取景', 'Camera view')} />
      {status === 'scanning' && <span className="battle-qr-frame" aria-hidden="true" />}
      {status !== 'scanning' && <p className="battle-qr-status" role="status">{status === 'starting' ? t('正在打开相机…', 'Opening camera…') : status === 'denied' ? t('相机权限被拒绝。可在系统设置中允许，或改用图片识别。', 'Camera access was denied. Allow it in Settings, or pick an image instead.') : t('此设备无法使用相机，可改用图片识别。', 'The camera is not available here. Pick an image instead.')}</p>}
    </div>
    <p className="battle-dialog-caption" role="status">{hint || t('将房间二维码对准取景框。', 'Point the camera at the room QR code.')}</p>
    <label className="battle-button battle-button-subtle battle-qr-pick">{t('从图片识别', 'Scan from image')}<input type="file" accept="image/*" onChange={event => void pickImage(event)} /></label>
  </div>
}

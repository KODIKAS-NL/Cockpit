// The row of pasted-image thumbnails with a ✕ on each: under the prompt box, and (smaller) under
// the plan notes and the question notes.
import type { Translator } from '../i18n';
import type { ImageAttachment } from '../../../shared/protocol';
import { useImageViewer } from './ImageViewer';

export interface PastedImage extends ImageAttachment {
  id: string;
  url: string;
}

let seq = 0;

/** Reads an image file into an attachment (base64 plus a data URL for the thumbnail). */
export function readImage(f: File): Promise<PastedImage> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve({
        id: `i_${Date.now()}_${seq++}`,
        mediaType: f.type || 'image/png',
        data: comma >= 0 ? url.slice(comma + 1) : '',
        url,
      });
    };
    reader.readAsDataURL(f);
  });
}

interface Props {
  t: Translator;
  images: PastedImage[];
  onRemove: (id: string) => void;
  small?: boolean;
}

export function Attachments({ t, images, onRemove, small }: Props) {
  const openImage = useImageViewer();
  if (images.length === 0) return null;
  return (
    <div className={`attachments${small ? ' small' : ''}`}>
      {images.map((img) => (
        <div className="attachment" key={img.id}>
          <button type="button" className="attachment-thumb" title={t('attach.view')} onClick={() => openImage(img.url)}>
            <img src={img.url} alt="" />
          </button>
          <button type="button" className="attachment-remove" title={t('attach.remove')} onClick={() => onRemove(img.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

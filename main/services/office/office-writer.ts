import { extOfPath, isInPlaceWritableOfficeExtension, type OfficeEditablePayload } from '../../../contracts/office-preview';
import { writeDocxBuffer, writeOdtBuffer } from './document-writer';
import { writeOdpBuffer, writePptxBuffer } from './presentation-writer';
import { writeDelimitedBuffer, writeOdsBuffer, writeXlsxBuffer } from './spreadsheet-writer';
import { writeXmindArchive } from './xmind';
import { OfficeParseError } from './xml';

export async function writeOfficeBuffer(
  targetPath: string,
  payload: OfficeEditablePayload,
  existingBytes?: Buffer,
): Promise<Buffer> {
  const ext = extOfPath(targetPath);
  if (!isInPlaceWritableOfficeExtension(ext)) {
    throw new OfficeParseError('unsupported', `Saving directly to .${ext || 'unknown'} is not supported; use Save As instead.`);
  }

  if (payload.kind === 'spreadsheet') {
    if (ext === 'csv') return writeDelimitedBuffer(payload, ',');
    if (ext === 'tsv') return writeDelimitedBuffer(payload, '\t');
    if (ext === 'ods') return writeOdsBuffer(payload);
    if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xltx' || ext === 'xltm') {
      return writeXlsxBuffer(payload, existingBytes);
    }
    throw new OfficeParseError('unsupported', `Spreadsheet payload cannot be written as .${ext}`);
  }

  if (payload.kind === 'document') {
    if (ext === 'odt') return writeOdtBuffer(payload);
    if (ext === 'docx' || ext === 'docm' || ext === 'dotx' || ext === 'dotm') {
      return writeDocxBuffer(payload, existingBytes);
    }
    throw new OfficeParseError('unsupported', `Document payload cannot be written as .${ext}`);
  }

  if (payload.kind === 'presentation') {
    if (ext === 'odp') return writeOdpBuffer(payload);
    if (ext === 'pptx' || ext === 'pptm' || ext === 'ppsx' || ext === 'ppsm' || ext === 'potx' || ext === 'potm') {
      return writePptxBuffer(payload, existingBytes);
    }
    throw new OfficeParseError('unsupported', `Presentation payload cannot be written as .${ext}`);
  }

  if (payload.kind === 'mindmap') {
    if (ext === 'xmind') {
      return writeXmindArchive(payload, existingBytes);
    }
    throw new OfficeParseError('unsupported', `Mind map payload cannot be written as .${ext}`);
  }

  throw new OfficeParseError('unsupported', 'Unsupported Office payload');
}

import speaker from "@phosphor-icons/core/assets/regular/speaker-high.svg?raw";
import { RawHtml } from "../components/RawHtml";

const artwork = speaker
  .replace(/\s(?:width|height)="[^"]*"/g, "")
  .replace("<svg", '<svg width="18" height="18" aria-hidden="true"');
export function SpeakerIcon() {
  return <RawHtml tag="span" className="pet-speaker-icon" html={artwork} />;
}

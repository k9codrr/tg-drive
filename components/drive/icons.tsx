import {
  AppWindow,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  File as FileGeneric,
  Folder,
  Presentation,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { extOf, kindOf, type Kind } from "./lib";

const ICON: Record<Kind, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: ScrollText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  text: FileText,
  code: FileCode2,
  archive: FileArchive,
  font: FileType2,
  app: AppWindow,
  other: FileGeneric,
};

/** Coloured icon for a file type. Colours come from CSS (--k-<kind>) so every theme can tune them. */
export function KindIcon({
  kind,
  size = 18,
  className = "",
}: {
  kind: Kind;
  size?: number;
  className?: string;
}) {
  const Icon = ICON[kind];
  return (
    <Icon
      aria-hidden
      size={size}
      strokeWidth={1.9}
      className={`kindIcon k-${kind} ${className}`}
      fill={kind === "folder" ? "currentColor" : "none"}
      fillOpacity={kind === "folder" ? 0.22 : 0}
    />
  );
}

export function FileTypeIcon({ mime, name, size }: { mime: string; name: string; size?: number }) {
  return <KindIcon kind={kindOf(mime, name)} size={size} />;
}

/** Big tile used in grid view when there's no thumbnail: icon plus the extension. */
export function KindTile({ mime, name }: { mime: string; name: string }) {
  const kind = kindOf(mime, name);
  const ext = extOf(name);
  return (
    <div className={`kindTile kt-${kind}`}>
      <KindIcon kind={kind} size={40} />
      {ext && ext.length <= 5 && <span className="kindExt">{ext}</span>}
    </div>
  );
}

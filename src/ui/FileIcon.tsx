import { File, FileText, Image } from "lucide-react";
import { isImage, isNote } from "../vault/paths";

export function FileIcon({ path }: { path: string }) {
  if (isNote(path)) return <FileText className="size-3.5 shrink-0 text-[#5b8def] group-data-[selected=true]:text-inherit" />;
  if (isImage(path)) return <Image className="size-3.5 shrink-0 text-[#8e7cc3] group-data-[selected=true]:text-inherit" />;
  return <File className="size-3.5 shrink-0 text-subtle" />;
}

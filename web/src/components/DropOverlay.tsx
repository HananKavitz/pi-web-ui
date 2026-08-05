import { FiCopy, FiPaperclip } from "react-icons/fi";
import { useT } from "../i18n";

export interface DropZoneState {
	kind: "panel" | "chat";
	/** Workspace-relative folder under the cursor ("" = current dir, null = panel background). */
	folder: string | null;
}

/**
 * Full-window hint shown while dragging OS files over the app. pointer-events
 * none — the actual drop lands on the zone element underneath, which performs
 * the upload.
 */
export function DropOverlay({ zone }: { zone: DropZoneState | null }) {
	const t = useT();
	if (!zone) return null;
	const label =
		zone.kind === "chat"
			? t("dropReference")
			: zone.folder
				? t("dropCopyTo", { path: zone.folder })
				: t("dropCopyHere");
	return (
		<div className="drop-overlay">
			<div className="drop-pill">
				{zone.kind === "chat" ? <FiPaperclip /> : <FiCopy />}
				<span>{label}</span>
			</div>
		</div>
	);
}

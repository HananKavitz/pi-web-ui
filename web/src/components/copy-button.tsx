import { memo, useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";

export const CopyButton = memo(function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	if (!text) return null;
	return (
		<button
			type="button"
			className="copy-btn"
			title="复制"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			{copied ? <FiCheck /> : <FiCopy />}
		</button>
	);
});

import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiCpu } from "react-icons/fi";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
}

export function ThinkingBlock({ thinking, streaming }: ThinkingBlockProps) {
	const [open, setOpen] = useState(false);
	const preview = thinking.split("\n")[0].slice(0, 80);

	return (
		<div className={`thinking ${open ? "open" : ""}`}>
			<button
				type="button"
				className="thinking-toggle"
				onClick={() => setOpen((v) => !v)}
			>
				{open ? <FiChevronDown /> : <FiChevronRight />}
				<FiCpu className="thinking-icon" />
				<span className="thinking-label">
					{streaming ? "思考中…" : open ? "思考" : `思考：${preview}`}
				</span>
			</button>
			{open && <div className="thinking-body">{thinking}</div>}
		</div>
	);
}

import { useEffect, useRef, type ReactNode } from "react";
import { FiChevronDown } from "react-icons/fi";

interface DropdownProps {
	/** The clickable trigger (chip/button). */
	trigger: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	/** Align the menu edge with the trigger's edge (default right, since the
	 * toolbar sits at the top-right of the window). */
	align?: "left" | "right";
}

/** Click-outside-aware dropdown menu. */
export function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "right",
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onOpenChange(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onOpenChange(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onOpenChange]);

	return (
		<div className={`dropdown ${align}`} ref={ref}>
			<button
				type="button"
				className="chip"
				onClick={() => onOpenChange(!open)}
				aria-expanded={open}
			>
				{trigger}
				<FiChevronDown className={`dd-caret ${open ? "up" : ""}`} />
			</button>
			{open && <div className="dd-menu">{children}</div>}
		</div>
	);
}

export function DropdownItem({
	active,
	onClick,
	children,
}: {
	active?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`dd-item ${active ? "active" : ""}`}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

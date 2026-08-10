export function createChildBaseArgs(rubberDuckExtensionPath: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		rubberDuckExtensionPath,
	];
}

Verify whether generated classes overlap with openai-java.

Inputs:
- Generated source root: {{generated_root}}
- openai-java dependency (group:artifact) or pom module: {{dependency}}

Steps:
1. Identify the openai-java dependency version from pom.xml if needed.
2. Locate the openai-java JAR in ~/.m2.
3. List classes from the JAR and compare against generated classes under the source root.
4. Report any duplicates and their package names.

Ask for missing inputs before running commands.

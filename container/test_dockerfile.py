from pathlib import Path


def test_dockerfile_does_not_copy_retired_atrust_module():
    dockerfile = Path(__file__).with_name("Dockerfile").read_text()
    copy_lines = [
        line for line in dockerfile.splitlines() if line.startswith("COPY ")
    ]
    assert all("cqu_atrust.py" not in line for line in copy_lines)


def test_dockerfile_copies_browser_profile_module_imported_by_server():
    dockerfile = Path(__file__).with_name("Dockerfile").read_text()
    copy_lines = [
        line for line in dockerfile.splitlines() if line.startswith("COPY ")
    ]
    assert any("browser_profile.py" in line for line in copy_lines)

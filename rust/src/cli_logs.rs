//! Local, bounded log reads. No socket, owner token, display config or daemon startup.
use anyhow::{Result, anyhow, ensure};
use rustix::fs::{Mode, OFlags, open, openat};
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::Path;

const SCAN_BYTES: usize = 16 * 1024 * 1024;
const OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;

enum Selection {
    Tail(u64),
    Skip(u64),
}

fn js_space(ch: char) -> bool {
    matches!(ch as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

// TS num(value, 50): parseInt base 10, default on missing/invalid/infinite.
fn selection(value: Option<&str>) -> Selection {
    let n = value
        .and_then(|value| {
            let value = value.trim_start_matches(js_space);
            let sign = usize::from(value.starts_with(['+', '-']));
            let digits = value.as_bytes()[sign..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            (digits != 0)
                .then(|| value[..sign + digits].parse::<f64>().ok())
                .flatten()
                .filter(|n| n.is_finite())
        })
        .unwrap_or(50.0);
    if n > 0.0 {
        Selection::Tail(n as u64)
    } else {
        Selection::Skip((-n) as u64)
    }
}

fn nonblank_reversed(bytes: &[u8]) -> bool {
    let bytes: Vec<u8> = bytes.iter().rev().copied().collect();
    !String::from_utf8_lossy(&bytes)
        .trim_matches(js_space)
        .is_empty()
}

fn read(file: &File, selection: Selection) -> Result<String> {
    let metadata = file
        .metadata()
        .map_err(|_| anyhow!("local log cannot be read"))?;
    ensure!(metadata.is_file(), "local log must be a regular file");
    // Read a fixed end offset. Appends after this observation belong to a later invocation.
    let mut offset = metadata.len();
    let mut reversed = Vec::new();
    let mut line_start = 0;
    let mut found = 0_u64;
    let mut chunk = [0_u8; CHUNK_BYTES];
    'scan: while offset > 0 {
        let count = offset.min(CHUNK_BYTES as u64) as usize;
        offset -= count as u64;
        file.read_exact_at(&mut chunk[..count], offset)
            .map_err(|_| anyhow!("local log changed or cannot be read"))?;
        for byte in chunk[..count].iter().rev() {
            ensure!(
                reversed.len() < SCAN_BYTES,
                "local log scan exceeds 16 MiB limit"
            );
            reversed.push(*byte);
            if *byte == b'\n' {
                if nonblank_reversed(&reversed[line_start..reversed.len() - 1]) {
                    found += 1;
                }
                line_start = reversed.len();
                if matches!(selection, Selection::Tail(n) if found >= n) {
                    break 'scan;
                }
            }
        }
    }
    reversed.reverse();
    let text = String::from_utf8_lossy(&reversed);
    let skip = match selection {
        Selection::Tail(_) => 0,
        Selection::Skip(n) => usize::try_from(n).unwrap_or(usize::MAX),
    };
    let mut output = String::new();
    for line in text
        .split('\n')
        .filter(|line| !line.trim_matches(js_space).is_empty())
        .skip(skip)
    {
        ensure!(
            output.len() + line.len() < OUTPUT_BYTES,
            "local log output exceeds 4 MiB limit"
        );
        output.push_str(line);
        output.push('\n');
    }
    // TS out('') still prints one newline.
    if output.is_empty() {
        output.push('\n');
    }
    Ok(output)
}

pub fn run(home: &Path, lines: Option<&str>) -> Result<()> {
    ensure!(
        [
            "PULT_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY",
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_none()),
        "local daemon logs are unavailable to scoped credentials"
    );
    let home = pult_core::checked_home(home)?;
    // Anchor each path component to an owned FD. NONBLOCK prevents FIFO open hangs;
    // NOFOLLOW applies to both the logs directory and the final file.
    let directory =
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let home = open(&home, directory, Mode::empty())
        .map_err(|_| anyhow!("local log home cannot be opened"))?;
    let logs = openat(&home, "logs", directory, Mode::empty())
        .map_err(|_| anyhow!("local log directory cannot be opened"))?;
    let file = File::from(
        openat(
            &logs,
            "pultd.log",
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| anyhow!("local log cannot be opened"))?,
    );
    let output = read(&file, selection(lines))?;
    std::io::stdout()
        .lock()
        .write_all(output.as_bytes())
        .map_err(|_| anyhow!("local log output failed"))
}

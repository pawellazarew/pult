use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

fn running(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}

async fn wait_gone(pids: &[u32]) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        if pids.iter().all(|pid| !running(*pid)) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn core(dir: &std::path::Path) -> Child {
    Command::new(
        std::env::var("PULT_R1_TEST_BIN").unwrap_or_else(|_| env!("CARGO_BIN_EXE_pult-r1").into()),
    )
    .arg("--home")
    .arg(dir)
    .arg("serve")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .spawn()
    .unwrap()
}

#[tokio::test]
async fn sigkill_owner_cleans_provider_and_grandchild_without_test_intervention() {
    for cooperative in [true, false] {
        let home = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let pidfile = home.path().join("provider-pids");
        let script = "import os,subprocess,time,sys,signal\nc=subprocess.Popen(['sleep','60'])\ndef stop(*a):\n c.terminate();c.wait();sys.exit(0)\nsignal.signal(signal.SIGTERM,stop if sys.argv[2]=='yes' else signal.SIG_IGN)\nopen(sys.argv[1]+'.tmp','w').write(str(os.getpid())+' '+str(c.pid))\nos.replace(sys.argv[1]+'.tmp',sys.argv[1])\nwhile True: time.sleep(.1)";
        let mut daemon = core(home.path()).await;
        let request = json!({"method":"start","program":"python3","args":["-c",script,pidfile,if cooperative {"yes"} else {"no"}],"cwd":home.path()});
        daemon
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let mut out = BufReader::new(daemon.stdout.take().unwrap());
        let ack = tokio::time::timeout(Duration::from_secs(5), pult_r1::bounded_line(&mut out))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let holder = serde_json::from_slice::<serde_json::Value>(&ack).unwrap()["started"]
            .as_u64()
            .unwrap() as u32;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !pidfile.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "provider did not start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let text = std::fs::read_to_string(&pidfile).unwrap();
        let mut pids: Vec<u32> = text
            .split_whitespace()
            .map(|n| n.parse().unwrap())
            .collect();
        assert_eq!(pids.len(), 2);
        assert!(pids.iter().all(|pid| *pid > 1 && running(*pid)));
        assert_ne!(pids[0], pids[1]);
        daemon.start_kill().unwrap();
        daemon.wait().await.unwrap();
        pids.push(holder);
        let gone = wait_gone(&pids).await;
        if !gone {
            // Failure-only cleanup is never counted as successful lifecycle evidence.
            for pid in &pids {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
        }
        assert!(gone, "provider/descendant survived core SIGKILL");
    }
}

#[tokio::test]
async fn holder_refuses_launch_if_owner_was_lost_before_startup() {
    let home = tempfile::tempdir().unwrap();
    let marker = home.path().join("should-not-exist");
    let status = Command::new(env!("CARGO_BIN_EXE_pult-r1-holder"))
        .args(["2147483647", "/bin/sh", "-c"])
        .arg(format!("touch '{}'", marker.display()))
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(!status.success());
    assert!(!marker.exists());
}

#[tokio::test]
async fn naturally_exiting_provider_output_is_drained_before_holder_exit() {
    let home = tempfile::tempdir().unwrap();
    let mut process = pult_r1::Process::spawn(
        "python3",
        &[
            "-c".into(),
            "import json; [print(json.dumps({'i':i})) for i in range(100)]".into(),
        ],
        home.path(),
    )
    .await
    .unwrap();
    for i in 0..100 {
        let value = tokio::time::timeout(Duration::from_secs(3), process.output.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(value, json!({"i":i}));
    }
    process.stop().await.unwrap();
}

#[tokio::test]
async fn natural_provider_failure_keeps_its_exit_code() {
    let home = tempfile::tempdir().unwrap();
    let mut process = pult_r1::Process::spawn(
        "/bin/sh",
        &["-c".into(), "printf '{}\\n'; exit 7".into()],
        home.path(),
    )
    .await
    .unwrap();
    assert!(process.output.recv().await.unwrap().is_ok());
    assert!(
        tokio::time::timeout(Duration::from_secs(3), process.output.recv())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(process.stop().await.unwrap()["code"], 7);
}

#[tokio::test]
async fn missing_provider_is_rejected_before_startup_success() {
    let home = tempfile::tempdir().unwrap();
    let error = match pult_r1::Process::spawn("/definitely/missing/pult-provider", &[], home.path())
        .await
    {
        Ok(mut process) => {
            process.stop().await.unwrap();
            panic!("missing provider acknowledged");
        }
        Err(error) => error,
    };
    assert!(error.to_string().contains("startup failed"));
}

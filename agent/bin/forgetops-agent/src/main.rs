mod pair;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next();
    let result = match command.as_deref() {
        Some("pair") => pair::run(arguments.collect()),
        _ => Err(pair::usage().to_owned()),
    };

    match result {
        Ok(output) => println!("{output}"),
        Err(message) => {
            eprintln!("forgetops-agent: {message}");
            std::process::exit(2);
        }
    }
}

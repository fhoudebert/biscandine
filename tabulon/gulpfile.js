import gulp from 'gulp';
import jison from 'gulp-jison';
import insert from 'gulp-insert';

// Compile le parser Jison PJN → CommonJS dans app/
export function buildPjnParser() {
  return gulp.src('./pjn-parser/*.jison')
    .pipe(jison({ moduleType: 'commonjs' }))
    .pipe(insert.prepend('// jshint ignore: start\n'))
    .pipe(gulp.dest('./app/'));
}

export default buildPjnParser;
